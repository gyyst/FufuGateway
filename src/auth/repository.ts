import { GatewayError } from "../core/errors";
import { newId } from "../core/ids";
import type { ApiKeyRecord, ApiKeyStatus, UserRecord, UserRole, UserStatus } from "./types";

interface UserRow {
  id: string;
  tenant_id: string;
  email: string | null;
  display_name: string | null;
  role: string;
  status: string;
  rpm_limit: number | null;
  tpm_limit: number | null;
  concurrency_limit: number | null;
  daily_budget_usd: number | null;
  monthly_budget_usd: number | null;
  created_at: number;
  updated_at: number;
}

interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string;
  model_allowlist: string | null;
  provider_allowlist: string | null;
  rpm_limit: number | null;
  tpm_limit: number | null;
  concurrency_limit: number | null;
  daily_budget_usd: number | null;
  monthly_budget_usd: number | null;
  expires_at: number | null;
  status: string;
  rotated_from: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

interface JoinedKeyRow extends ApiKeyRow {
  u_id: string;
  u_tenant_id: string;
  u_email: string | null;
  u_display_name: string | null;
  u_role: string;
  u_status: string;
  u_rpm_limit: number | null;
  u_tpm_limit: number | null;
  u_concurrency_limit: number | null;
  u_daily_budget_usd: number | null;
  u_monthly_budget_usd: number | null;
  u_created_at: number;
  u_updated_at: number;
}

function parseStringArray(text: string | null): string[] | undefined {
  if (text === null) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) return undefined;
    return value.filter((item): item is string => typeof item === "string");
  } catch {
    throw new GatewayError({ code: "CONFIG_INVALID", message: "Stored API key configuration contains invalid JSON" });
  }
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ...(row.email === null ? {} : { email: row.email }),
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    role: row.role as UserRole,
    status: row.status as UserStatus,
    ...(row.rpm_limit === null ? {} : { rpmLimit: row.rpm_limit }),
    ...(row.tpm_limit === null ? {} : { tpmLimit: row.tpm_limit }),
    ...(row.concurrency_limit === null ? {} : { concurrencyLimit: row.concurrency_limit }),
    ...(row.daily_budget_usd === null ? {} : { dailyBudgetUsd: row.daily_budget_usd }),
    ...(row.monthly_budget_usd === null ? {} : { monthlyBudgetUsd: row.monthly_budget_usd }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapJoinedUser(row: JoinedKeyRow): UserRecord {
  return mapUser({
    id: row.u_id,
    tenant_id: row.u_tenant_id,
    email: row.u_email,
    display_name: row.u_display_name,
    role: row.u_role,
    status: row.u_status,
    rpm_limit: row.u_rpm_limit,
    tpm_limit: row.u_tpm_limit,
    concurrency_limit: row.u_concurrency_limit,
    daily_budget_usd: row.u_daily_budget_usd,
    monthly_budget_usd: row.u_monthly_budget_usd,
    created_at: row.u_created_at,
    updated_at: row.u_updated_at,
  });
}

export function mapApiKey(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    keyHash: row.key_hash,
    scopes: parseStringArray(row.scopes) ?? ["inference"],
    ...(row.model_allowlist === null ? {} : { modelAllowlist: parseStringArray(row.model_allowlist) }),
    ...(row.provider_allowlist === null ? {} : { providerAllowlist: parseStringArray(row.provider_allowlist) }),
    ...(row.rpm_limit === null ? {} : { rpmLimit: row.rpm_limit }),
    ...(row.tpm_limit === null ? {} : { tpmLimit: row.tpm_limit }),
    ...(row.concurrency_limit === null ? {} : { concurrencyLimit: row.concurrency_limit }),
    ...(row.daily_budget_usd === null ? {} : { dailyBudgetUsd: row.daily_budget_usd }),
    ...(row.monthly_budget_usd === null ? {} : { monthlyBudgetUsd: row.monthly_budget_usd }),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    status: row.status as ApiKeyStatus,
    ...(row.rotated_from === null ? {} : { rotatedFrom: row.rotated_from }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
  };
}

export async function findUserById(db: D1Database, id: string): Promise<UserRecord | undefined> {
  const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  return row === null ? undefined : mapUser(row);
}

export async function listUsers(db: D1Database): Promise<UserRecord[]> {
  const rows = await db.prepare("SELECT * FROM users ORDER BY created_at DESC").all<UserRow>();
  return rows.results.map(mapUser);
}

export async function findUserByEmail(db: D1Database, email: string): Promise<UserRecord | undefined> {
  const row = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
  return row === null ? undefined : mapUser(row);
}

export async function findApiKeyAuthentication(
  db: D1Database,
  keyHash: string,
): Promise<{ apiKey: ApiKeyRecord; user: UserRecord } | undefined> {
  const row = await db
    .prepare(
      `SELECT k.*, u.id AS u_id, u.tenant_id AS u_tenant_id, u.email AS u_email,
              u.display_name AS u_display_name, u.role AS u_role, u.status AS u_status,
              u.rpm_limit AS u_rpm_limit, u.tpm_limit AS u_tpm_limit,
              u.concurrency_limit AS u_concurrency_limit, u.daily_budget_usd AS u_daily_budget_usd,
              u.monthly_budget_usd AS u_monthly_budget_usd,
              u.created_at AS u_created_at, u.updated_at AS u_updated_at
       FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = ? LIMIT 1`,
    )
    .bind(keyHash)
    .first<JoinedKeyRow>();
  if (row === null) return undefined;
  return { apiKey: mapApiKey(row), user: mapJoinedUser(row) };
}

export async function getApiKey(db: D1Database, id: string): Promise<ApiKeyRecord | undefined> {
  const row = await db.prepare("SELECT * FROM api_keys WHERE id = ?").bind(id).first<ApiKeyRow>();
  return row === null ? undefined : mapApiKey(row);
}

export async function listApiKeys(db: D1Database, userId?: string): Promise<ApiKeyRecord[]> {
  const statement = userId
    ? db.prepare("SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC").bind(userId)
    : db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC");
  const rows = await statement.all<ApiKeyRow>();
  return rows.results.map(mapApiKey);
}

export interface CreateUserInput {
  tenantId?: string;
  email?: string;
  displayName?: string;
  role?: UserRole;
  rpmLimit?: number;
  tpmLimit?: number;
  concurrencyLimit?: number;
  dailyBudgetUsd?: number;
  monthlyBudgetUsd?: number;
}

export async function replaceUser(db: D1Database, user: UserRecord): Promise<void> {
  await db
    .prepare(
      `UPDATE users SET tenant_id = ?, email = ?, display_name = ?, role = ?, status = ?,
        rpm_limit = ?, tpm_limit = ?, concurrency_limit = ?, daily_budget_usd = ?, monthly_budget_usd = ?,
        updated_at = ? WHERE id = ?`,
    )
    .bind(
      user.tenantId,
      user.email ?? null,
      user.displayName ?? null,
      user.role,
      user.status,
      user.rpmLimit ?? null,
      user.tpmLimit ?? null,
      user.concurrencyLimit ?? null,
      user.dailyBudgetUsd ?? null,
      user.monthlyBudgetUsd ?? null,
      Date.now(),
      user.id,
    )
    .run();
}

export async function createUser(db: D1Database, input: CreateUserInput): Promise<UserRecord> {
  const timestamp = Date.now();
  const user: UserRecord = {
    id: newId("usr"),
    tenantId: input.tenantId ?? "default",
    ...(input.email === undefined ? {} : { email: input.email }),
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    role: input.role ?? "user",
    status: "active",
    ...(input.rpmLimit === undefined ? {} : { rpmLimit: input.rpmLimit }),
    ...(input.tpmLimit === undefined ? {} : { tpmLimit: input.tpmLimit }),
    ...(input.concurrencyLimit === undefined ? {} : { concurrencyLimit: input.concurrencyLimit }),
    ...(input.dailyBudgetUsd === undefined ? {} : { dailyBudgetUsd: input.dailyBudgetUsd }),
    ...(input.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: input.monthlyBudgetUsd }),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await db
    .prepare(
      `INSERT INTO users
        (id, tenant_id, email, display_name, role, status,
         rpm_limit, tpm_limit, concurrency_limit, daily_budget_usd, monthly_budget_usd,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      user.id,
      user.tenantId,
      user.email ?? null,
      user.displayName ?? null,
      user.role,
      user.status,
      user.rpmLimit ?? null,
      user.tpmLimit ?? null,
      user.concurrencyLimit ?? null,
      user.dailyBudgetUsd ?? null,
      user.monthlyBudgetUsd ?? null,
      user.createdAt,
      user.updatedAt,
    )
    .run();
  return user;
}

export interface CreateApiKeyInput {
  userId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes?: string[];
  modelAllowlist?: string[];
  providerAllowlist?: string[];
  rpmLimit?: number;
  tpmLimit?: number;
  concurrencyLimit?: number;
  dailyBudgetUsd?: number;
  monthlyBudgetUsd?: number;
  expiresAt?: number;
  rotatedFrom?: string;
}

export async function createApiKeyRecord(db: D1Database, input: CreateApiKeyInput): Promise<ApiKeyRecord> {
  const timestamp = Date.now();
  const record: ApiKeyRecord = {
    id: newId("key"),
    userId: input.userId,
    name: input.name,
    keyPrefix: input.keyPrefix,
    keyHash: input.keyHash,
    scopes: input.scopes ?? ["inference"],
    ...(input.modelAllowlist === undefined ? {} : { modelAllowlist: input.modelAllowlist }),
    ...(input.providerAllowlist === undefined ? {} : { providerAllowlist: input.providerAllowlist }),
    ...(input.rpmLimit === undefined ? {} : { rpmLimit: input.rpmLimit }),
    ...(input.tpmLimit === undefined ? {} : { tpmLimit: input.tpmLimit }),
    ...(input.concurrencyLimit === undefined ? {} : { concurrencyLimit: input.concurrencyLimit }),
    ...(input.dailyBudgetUsd === undefined ? {} : { dailyBudgetUsd: input.dailyBudgetUsd }),
    ...(input.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: input.monthlyBudgetUsd }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.rotatedFrom === undefined ? {} : { rotatedFrom: input.rotatedFrom }),
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await db
    .prepare(
      `INSERT INTO api_keys
        (id, user_id, name, key_prefix, key_hash, scopes, model_allowlist, provider_allowlist,
         rpm_limit, tpm_limit, concurrency_limit, daily_budget_usd, monthly_budget_usd,
         expires_at, status, rotated_from, created_at, updated_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      record.id,
      record.userId,
      record.name,
      record.keyPrefix,
      record.keyHash,
      JSON.stringify(record.scopes),
      record.modelAllowlist === undefined ? null : JSON.stringify(record.modelAllowlist),
      record.providerAllowlist === undefined ? null : JSON.stringify(record.providerAllowlist),
      record.rpmLimit ?? null,
      record.tpmLimit ?? null,
      record.concurrencyLimit ?? null,
      record.dailyBudgetUsd ?? null,
      record.monthlyBudgetUsd ?? null,
      record.expiresAt ?? null,
      record.status,
      record.rotatedFrom ?? null,
      record.createdAt,
      record.updatedAt,
    )
    .run();
  return record;
}

export async function replaceApiKey(db: D1Database, record: ApiKeyRecord): Promise<void> {
  await db
    .prepare(
      `UPDATE api_keys SET name = ?, scopes = ?, model_allowlist = ?, provider_allowlist = ?,
        rpm_limit = ?, tpm_limit = ?, concurrency_limit = ?, daily_budget_usd = ?, monthly_budget_usd = ?,
        expires_at = ?, status = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      record.name,
      JSON.stringify(record.scopes),
      record.modelAllowlist === undefined ? null : JSON.stringify(record.modelAllowlist),
      record.providerAllowlist === undefined ? null : JSON.stringify(record.providerAllowlist),
      record.rpmLimit ?? null,
      record.tpmLimit ?? null,
      record.concurrencyLimit ?? null,
      record.dailyBudgetUsd ?? null,
      record.monthlyBudgetUsd ?? null,
      record.expiresAt ?? null,
      record.status,
      Date.now(),
      record.id,
    )
    .run();
}

export async function deleteApiKey(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM api_keys WHERE id = ?").bind(id).run();
}

export async function touchApiKey(db: D1Database, id: string, timestamp: number): Promise<void> {
  await db
    .prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)")
    .bind(timestamp, id, timestamp - 60_000)
    .run();
}

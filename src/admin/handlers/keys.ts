import type { Context } from "hono";
import type { AppEnv } from "../../app";
import { GatewayError } from "../../core/errors";
import { generateApiKey } from "../../auth/api-key";
import {
  createApiKeyRecord,
  createUser,
  deleteApiKey,
  findUserByEmail,
  findUserById,
  getApiKey,
  listApiKeys,
  listUsers,
  replaceApiKey,
  replaceUser,
} from "../../auth/repository";
import type { ApiKeyRecord, UserRecord } from "../../auth/types";
import { apiKeyCreateSchema, apiKeyRotateSchema, apiKeyUpdateSchema, userCreateSchema, userUpdateSchema } from "../schemas";
import { parseAdminBody, recordAudit, requireParam } from "../shared";

function publicApiKey(key: ApiKeyRecord): Record<string, unknown> {
  const { keyHash, ...rest } = key;
  void keyHash;
  return rest;
}

async function requireUser(c: Context<AppEnv>, id: string): Promise<UserRecord> {
  const user = await findUserById(c.env.DB, id);
  if (user === undefined) throw new GatewayError({ code: "NOT_FOUND", message: "User not found" });
  return user;
}

async function requireApiKey(c: Context<AppEnv>, id: string): Promise<ApiKeyRecord> {
  const key = await getApiKey(c.env.DB, id);
  if (key === undefined) throw new GatewayError({ code: "NOT_FOUND", message: "API key not found" });
  return key;
}

export async function listUsersHandler(c: Context<AppEnv>): Promise<Response> {
  return c.json({ data: await listUsers(c.env.DB) });
}

export async function getUserHandler(c: Context<AppEnv>): Promise<Response> {
  const user = await requireUser(c, requireParam(c, "id"));
  return c.json({ data: user });
}

export async function createUserHandler(c: Context<AppEnv>): Promise<Response> {
  const input = await parseAdminBody(c, userCreateSchema);
  if (input.email !== undefined) {
    const existing = await findUserByEmail(c.env.DB, input.email);
    if (existing !== undefined) {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "Email is already registered" });
    }
  }
  const user = await createUser(c.env.DB, {
    tenantId: input.tenantId,
    email: input.email,
    displayName: input.displayName,
    role: input.role,
    rpmLimit: input.rpmLimit ?? undefined,
    tpmLimit: input.tpmLimit ?? undefined,
    concurrencyLimit: input.concurrencyLimit ?? undefined,
    dailyBudgetUsd: input.dailyBudgetUsd ?? undefined,
    monthlyBudgetUsd: input.monthlyBudgetUsd ?? undefined,
  });
  await recordAudit(c, "user.create", "user", user.id, { role: user.role });
  return c.json({ data: user }, 201);
}

export async function updateUserHandler(c: Context<AppEnv>): Promise<Response> {
  const user = await requireUser(c, requireParam(c, "id"));
  const input = await parseAdminBody(c, userUpdateSchema);
  if (input.email !== undefined && input.email !== null) {
    const existing = await findUserByEmail(c.env.DB, input.email);
    if (existing !== undefined && existing.id !== user.id) {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "Email is already registered" });
    }
  }
  const updated: UserRecord = {
    ...user,
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    ...(input.email === undefined ? {} : input.email === null ? { email: undefined } : { email: input.email }),
    ...(input.displayName === undefined
      ? {}
      : input.displayName === null
        ? { displayName: undefined }
        : { displayName: input.displayName }),
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.status === undefined ? {} : { status: input.status }),
    updatedAt: Date.now(),
  };
  const applyLimit = (key: "rpmLimit" | "tpmLimit" | "concurrencyLimit" | "dailyBudgetUsd" | "monthlyBudgetUsd") => {
    const value = input[key];
    if (value === undefined) return;
    if (value === null) delete updated[key];
    else updated[key] = value;
  };
  applyLimit("rpmLimit");
  applyLimit("tpmLimit");
  applyLimit("concurrencyLimit");
  applyLimit("dailyBudgetUsd");
  applyLimit("monthlyBudgetUsd");
  if (updated.email === undefined) delete updated.email;
  if (updated.displayName === undefined) delete updated.displayName;
  await replaceUser(c.env.DB, updated);
  await recordAudit(c, "user.update", "user", user.id, { role: updated.role, status: updated.status });
  return c.json({ data: updated });
}

export async function listApiKeysHandler(c: Context<AppEnv>): Promise<Response> {
  const userId = c.req.query("userId");
  const keys = await listApiKeys(c.env.DB, userId);
  return c.json({ hashesHidden: true, data: keys.map(publicApiKey) });
}

export async function createApiKeyHandler(c: Context<AppEnv>): Promise<Response> {
  const input = await parseAdminBody(c, apiKeyCreateSchema);
  await requireUser(c, input.userId);
  const generated = await generateApiKey();
  const key = await createApiKeyRecord(c.env.DB, {
    userId: input.userId,
    name: input.name,
    keyPrefix: generated.prefix,
    keyHash: generated.hash,
    scopes: input.scopes,
    modelAllowlist: input.modelAllowlist,
    providerAllowlist: input.providerAllowlist,
    rpmLimit: input.rpmLimit ?? undefined,
    tpmLimit: input.tpmLimit ?? undefined,
    concurrencyLimit: input.concurrencyLimit ?? undefined,
    dailyBudgetUsd: input.dailyBudgetUsd ?? undefined,
    monthlyBudgetUsd: input.monthlyBudgetUsd ?? undefined,
    expiresAt: input.expiresAt ?? undefined,
  });
  await recordAudit(c, "api_key.create", "api_key", key.id, {
    userId: key.userId,
    name: key.name,
    scopes: key.scopes,
  });
  // 明文只在创建时返回一次。
  return c.json({ data: publicApiKey(key), key: generated.plaintext }, 201);
}

export async function updateApiKeyHandler(c: Context<AppEnv>): Promise<Response> {
  const key = await requireApiKey(c, requireParam(c, "id"));
  const input = await parseAdminBody(c, apiKeyUpdateSchema);
  const updated: ApiKeyRecord = { ...key, updatedAt: Date.now() };
  if (input.name !== undefined) updated.name = input.name;
  if (input.scopes !== undefined) updated.scopes = input.scopes;
  if (input.status !== undefined) updated.status = input.status;

  if (input.modelAllowlist !== undefined) {
    if (input.modelAllowlist === null) delete updated.modelAllowlist;
    else updated.modelAllowlist = input.modelAllowlist;
  }
  if (input.providerAllowlist !== undefined) {
    if (input.providerAllowlist === null) delete updated.providerAllowlist;
    else updated.providerAllowlist = input.providerAllowlist;
  }
  if (input.rpmLimit !== undefined) {
    if (input.rpmLimit === null) delete updated.rpmLimit;
    else updated.rpmLimit = input.rpmLimit;
  }
  if (input.tpmLimit !== undefined) {
    if (input.tpmLimit === null) delete updated.tpmLimit;
    else updated.tpmLimit = input.tpmLimit;
  }
  if (input.concurrencyLimit !== undefined) {
    if (input.concurrencyLimit === null) delete updated.concurrencyLimit;
    else updated.concurrencyLimit = input.concurrencyLimit;
  }
  if (input.dailyBudgetUsd !== undefined) {
    if (input.dailyBudgetUsd === null) delete updated.dailyBudgetUsd;
    else updated.dailyBudgetUsd = input.dailyBudgetUsd;
  }
  if (input.monthlyBudgetUsd !== undefined) {
    if (input.monthlyBudgetUsd === null) delete updated.monthlyBudgetUsd;
    else updated.monthlyBudgetUsd = input.monthlyBudgetUsd;
  }
  if (input.expiresAt !== undefined) {
    if (input.expiresAt === null) delete updated.expiresAt;
    else updated.expiresAt = input.expiresAt;
  }

  await replaceApiKey(c.env.DB, updated);
  await recordAudit(c, "api_key.update", "api_key", key.id, {
    status: updated.status,
    scopes: updated.scopes,
  });
  return c.json({ data: publicApiKey(updated) });
}

export async function deleteApiKeyHandler(c: Context<AppEnv>): Promise<Response> {
  const key = await requireApiKey(c, requireParam(c, "id"));
  await deleteApiKey(c.env.DB, key.id);
  await recordAudit(c, "api_key.delete", "api_key", key.id);
  return c.json({ deleted: true, id: key.id });
}

export async function rotateApiKeyHandler(c: Context<AppEnv>): Promise<Response> {
  const key = await requireApiKey(c, requireParam(c, "id"));
  const input = await parseAdminBody(c, apiKeyRotateSchema);
  const generated = await generateApiKey();
  const rotated = await createApiKeyRecord(c.env.DB, {
    userId: key.userId,
    name: `${key.name} (rotated)`,
    keyPrefix: generated.prefix,
    keyHash: generated.hash,
    scopes: key.scopes,
    modelAllowlist: key.modelAllowlist,
    providerAllowlist: key.providerAllowlist,
    rpmLimit: key.rpmLimit,
    tpmLimit: key.tpmLimit,
    concurrencyLimit: key.concurrencyLimit,
    dailyBudgetUsd: key.dailyBudgetUsd,
    monthlyBudgetUsd: key.monthlyBudgetUsd,
    expiresAt: key.expiresAt,
    rotatedFrom: key.id,
  });

  if (input.revokeOld !== false) {
    const old: ApiKeyRecord = { ...key, status: "revoked", updatedAt: Date.now() };
    await replaceApiKey(c.env.DB, old);
  }

  await recordAudit(c, "api_key.rotate", "api_key", rotated.id, { rotatedFrom: key.id });
  return c.json({ data: publicApiKey(rotated), key: generated.plaintext, rotatedFrom: key.id }, 201);
}

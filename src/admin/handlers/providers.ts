import type { Context } from "hono";
import type { AppEnv } from "../../app";
import { GatewayError, toGatewayError } from "../../core/errors";
import type { ProviderAccountRecord, ProviderRecord } from "../../config/types";
import {
  createAccount,
  createProvider,
  deleteAccount,
  deleteProvider,
  getAccount,
  getProvider,
  listAccounts,
  listModels,
  listProviders,
  replaceAccount,
  replaceProvider,
} from "../../config/repository";
import { selectAnyProviderAccount } from "../../execution/accounts";
import { fetchProviderModels } from "../../providers/engine";
import { syncProviderModels } from "../../models/sync";
import { isValidSecretRef, encryptSecret } from "../../security/crypto";
import {
  accountCreateSchema,
  accountUpdateSchema,
  providerCreateSchema,
  providerUpdateSchema,
} from "../schemas";
import {
  assertProviderTypeProtocol,
  parseAdminBody,
  recordAudit,
  requireParam,
  requireProviderId,
  sanitizeAccount,
  sanitizeProvider,
  validateProviderName,
  validateProviderUrlAndHeaders,
} from "../shared";

async function requireProvider(c: Context<AppEnv>, id: string): Promise<ProviderRecord> {
  const provider = await getProvider(c.env.DB, id);
  if (provider === undefined) {
    throw new GatewayError({ code: "PROVIDER_NOT_FOUND", message: `Provider "${id}" not found` });
  }
  return provider;
}

export async function listProviderHandler(c: Context<AppEnv>): Promise<Response> {
  const [providers, accounts] = await Promise.all([
    listProviders(c.env.DB),
    listAccounts(c.env.DB),
  ]);
  const counts = new Map<string, { total: number; enabled: number }>();
  for (const account of accounts) {
    const entry = counts.get(account.providerId) ?? { total: 0, enabled: 0 };
    entry.total += 1;
    if (account.enabled) entry.enabled += 1;
    counts.set(account.providerId, entry);
  }
  return c.json({
    data: providers.map((provider) => ({
      ...sanitizeProvider(provider),
      accountCount: counts.get(provider.id)?.total ?? 0,
      enabledAccountCount: counts.get(provider.id)?.enabled ?? 0,
    })),
  });
}

export async function getProviderHandler(c: Context<AppEnv>): Promise<Response> {
  const provider = await requireProvider(c, requireProviderId(c));
  const [accounts, models] = await Promise.all([
    listAccounts(c.env.DB, provider.id),
    listModels(c.env.DB),
  ]);
  return c.json({
    data: {
      ...sanitizeProvider(provider),
      accounts: accounts.map(sanitizeAccount),
      models: models.filter((model) => model.providerId === provider.id),
    },
  });
}

export async function createProviderHandler(c: Context<AppEnv>): Promise<Response> {
  const input = await parseAdminBody(c, providerCreateSchema);
  validateProviderName(input.name);
  assertProviderTypeProtocol(input.type, input.protocol);
  const customHeaders = validateProviderUrlAndHeaders(c, input.baseUrl, input.customHeaders);

  const record = await createProvider(c.env.DB, {
    name: input.name,
    type: input.type,
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    enabled: input.enabled,
    priority: input.priority,
    weight: input.weight,
    customHeaders,
    timeoutMs: input.timeoutMs,
    firstTokenTimeoutMs: input.firstTokenTimeoutMs,
    idleTimeoutMs: input.idleTimeoutMs,
    maxRetries: input.maxRetries,
    retry: input.retry ?? null,
    proxyConfig: input.proxyConfig ?? null,
    extraConfig: input.extraConfig,
  });
  await recordAudit(c, "provider.create", "provider", record.id, { name: record.name, type: record.type });
  return c.json({ data: sanitizeProvider(record) }, 201);
}

function mergeProvider(provider: ProviderRecord, input: Partial<typeof provider> & Record<string, unknown>): ProviderRecord {
  return {
    ...provider,
    ...(typeof input["name"] === "string" ? { name: input["name"] } : {}),
    ...(typeof input["type"] === "string" ? { type: input["type"] as ProviderRecord["type"] } : {}),
    ...(typeof input["protocol"] === "string" ? { protocol: input["protocol"] as ProviderRecord["protocol"] } : {}),
    ...(typeof input["baseUrl"] === "string" ? { baseUrl: input["baseUrl"] } : {}),
    ...(typeof input["enabled"] === "boolean" ? { enabled: input["enabled"] } : {}),
    ...(typeof input["priority"] === "number" ? { priority: input["priority"] } : {}),
    ...(typeof input["weight"] === "number" ? { weight: input["weight"] } : {}),
    ...(typeof input["timeoutMs"] === "number" ? { timeoutMs: input["timeoutMs"] } : {}),
    ...(typeof input["firstTokenTimeoutMs"] === "number" ? { firstTokenTimeoutMs: input["firstTokenTimeoutMs"] } : {}),
    ...(typeof input["idleTimeoutMs"] === "number" ? { idleTimeoutMs: input["idleTimeoutMs"] } : {}),
    ...(typeof input["maxRetries"] === "number" ? { maxRetries: input["maxRetries"] } : {}),
    ...(input["retry"] !== undefined ? { retry: input["retry"] as ProviderRecord["retry"] } : {}),
    ...(input["proxyConfig"] !== undefined ? { proxyConfig: input["proxyConfig"] as ProviderRecord["proxyConfig"] } : {}),
    ...(input["extraConfig"] !== undefined ? { extraConfig: input["extraConfig"] as Record<string, unknown> } : {}),
    updatedAt: Date.now(),
  };
}

export async function updateProviderHandler(c: Context<AppEnv>): Promise<Response> {
  const provider = await requireProvider(c, requireProviderId(c));
  const input = await parseAdminBody(c, providerUpdateSchema);
  const merged = mergeProvider(provider, input as unknown as Record<string, unknown>);

  validateProviderName(merged.name);
  assertProviderTypeProtocol(merged.type, merged.protocol);
  const customHeaders =
    input.customHeaders === undefined
      ? merged.customHeaders
      : validateProviderUrlAndHeaders(c, merged.baseUrl, input.customHeaders);
  validateProviderUrlAndHeaders(c, merged.baseUrl, customHeaders);

  const updated: ProviderRecord = { ...merged, customHeaders };
  await replaceProvider(c.env.DB, updated);
  await recordAudit(c, "provider.update", "provider", updated.id, { name: updated.name });
  return c.json({ data: sanitizeProvider(updated) });
}

export async function deleteProviderHandler(c: Context<AppEnv>): Promise<Response> {
  const provider = await requireProvider(c, requireProviderId(c));
  await deleteProvider(c.env.DB, provider.id);
  await recordAudit(c, "provider.delete", "provider", provider.id, { name: provider.name });
  return c.json({ deleted: true, id: provider.id });
}

export async function listAccountsHandler(c: Context<AppEnv>): Promise<Response> {
  const provider = await requireProvider(c, requireProviderId(c));
  const accounts = await listAccounts(c.env.DB, provider.id);
  return c.json({ data: accounts.map(sanitizeAccount) });
}

export async function createAccountHandler(c: Context<AppEnv>): Promise<Response> {
  const provider = await requireProvider(c, requireProviderId(c));
  const input = await parseAdminBody(c, accountCreateSchema);

  let encryptedKey;
  if (input.apiKey !== undefined) {
    encryptedKey = await encryptSecret(c.env, input.apiKey);
  } else if (input.secretRef !== undefined) {
    if (!isValidSecretRef(input.secretRef)) {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "secretRef must be an uppercase Worker Secret name" });
    }
  } else {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "Provide exactly one of apiKey or secretRef" });
  }

  const account = await createAccount(c.env.DB, {
    providerId: provider.id,
    name: input.name,
    ...(encryptedKey === undefined ? {} : { encryptedKey }),
    ...(input.secretRef === undefined ? {} : { secretRef: input.secretRef }),
    weight: input.weight,
    priority: input.priority,
    enabled: input.enabled,
  });
  await recordAudit(c, "account.create", "provider_account", account.id, {
    providerId: provider.id,
    credential: encryptedKey === undefined ? "secret_ref" : "encrypted",
  });
  return c.json({ data: sanitizeAccount(account) }, 201);
}

export async function updateAccountHandler(c: Context<AppEnv>): Promise<Response> {
  const provider = await requireProvider(c, requireProviderId(c));
  const accountId = requireParam(c, "accountId");
  const account = await getAccount(c.env.DB, accountId);
  if (account === undefined || account.providerId !== provider.id) {
    throw new GatewayError({ code: "NOT_FOUND", message: "Provider account not found" });
  }
  const input = await parseAdminBody(c, accountUpdateSchema);
  const updated: ProviderAccountRecord = {
    ...account,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.weight === undefined ? {} : { weight: input.weight }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    updatedAt: Date.now(),
  };
  if (input.apiKey !== undefined) {
    updated.encryptedKey = await encryptSecret(c.env, input.apiKey);
    delete updated.secretRef;
  }
  if (input.secretRef !== undefined) {
    if (!isValidSecretRef(input.secretRef)) {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "secretRef must be an uppercase Worker Secret name" });
    }
    updated.secretRef = input.secretRef;
    delete updated.encryptedKey;
  }
  await replaceAccount(c.env.DB, updated);
  await recordAudit(c, "account.update", "provider_account", account.id, { providerId: provider.id });
  return c.json({ data: sanitizeAccount(updated) });
}

export async function deleteAccountHandler(c: Context<AppEnv>): Promise<Response> {
  const provider = await requireProvider(c, requireProviderId(c));
  const accountId = requireParam(c, "accountId");
  const account = await getAccount(c.env.DB, accountId);
  if (account === undefined || account.providerId !== provider.id) {
    throw new GatewayError({ code: "NOT_FOUND", message: "Provider account not found" });
  }
  await deleteAccount(c.env.DB, account.id);
  await recordAudit(c, "account.delete", "provider_account", account.id, { providerId: provider.id });
  return c.json({ deleted: true, id: account.id });
}

export async function testProviderHandler(c: Context<AppEnv>): Promise<Response> {
  const provider = await requireProvider(c, requireProviderId(c));
  const startedAt = Date.now();
  try {
    const { account, apiKey } = await selectAnyProviderAccount(c.env, provider.id);
    const models = await fetchProviderModels({
      provider,
      apiKey,
      fetchImpl: c.get("fetchImpl"),
      timeoutMs: 20_000,
    });
    return c.json({
      ok: true,
      providerId: provider.id,
      accountId: account.id,
      latencyMs: Date.now() - startedAt,
      modelCount: models.length,
      sampleModels: models.slice(0, 20).map((model) => model.id),
    });
  } catch (error) {
    const gatewayError = toGatewayError(error);
    return c.json({
      ok: false,
      providerId: provider.id,
      latencyMs: Date.now() - startedAt,
      error: { code: gatewayError.code, message: gatewayError.publicMessage },
    });
  }
}

export async function syncModelsHandler(c: Context<AppEnv>): Promise<Response> {
  const provider = await requireProvider(c, requireProviderId(c));
  const { apiKey } = await selectAnyProviderAccount(c.env, provider.id);
  const result = await syncProviderModels(c.env, provider, apiKey, c.get("fetchImpl"));

  await recordAudit(c, "provider.sync_models", "provider", provider.id, {
    total: result.total,
    created: result.created,
    skipped: result.skipped,
  });

  return c.json({
    providerId: provider.id,
    total: result.total,
    created: result.created,
    skipped: result.skipped,
    createdModels: result.createdModels,
    requiresConfirmation: true,
    note: "Synced models are disabled until an administrator confirms their capabilities and enables them.",
  });
}

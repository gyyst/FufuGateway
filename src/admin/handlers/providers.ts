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
import { isValidSecretRef } from "../../security/secrets";
import {
  accountCreateSchema,
  accountUpdateSchema,
  providerCreateSchema,
  providerUpdateSchema,
} from "../schemas";
import {
  assertProviderTypeProtocol,
  configMutationResponse,
  parseAdminBody,
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
  return configMutationResponse(
    c,
    "provider.create",
    "provider",
    record.id,
    { name: record.name, type: record.type },
    { data: sanitizeProvider(record) },
    201,
  );
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
  return configMutationResponse(
    c,
    "provider.update",
    "provider",
    updated.id,
    { name: updated.name },
    { data: sanitizeProvider(updated) },
  );
}

export async function deleteProviderHandler(c: Context<AppEnv>): Promise<Response> {
  const provider = await requireProvider(c, requireProviderId(c));
  await deleteProvider(c.env.DB, provider.id);
  return configMutationResponse(
    c,
    "provider.delete",
    "provider",
    provider.id,
    { name: provider.name },
    { deleted: true, id: provider.id },
  );
}

export async function listAccountsHandler(c: Context<AppEnv>): Promise<Response> {
  const provider = await requireProvider(c, requireProviderId(c));
  const accounts = await listAccounts(c.env.DB, provider.id);
  return c.json({ data: accounts.map(sanitizeAccount) });
}

export async function createAccountHandler(c: Context<AppEnv>): Promise<Response> {
  const provider = await requireProvider(c, requireProviderId(c));
  const input = await parseAdminBody(c, accountCreateSchema);

  if (input.apiKey === undefined && input.secretRef === undefined) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "Provide exactly one of apiKey or secretRef" });
  }
  if (input.secretRef !== undefined && !isValidSecretRef(input.secretRef)) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "secretRef must be an uppercase Worker Secret name" });
  }

  const account = await createAccount(c.env.DB, {
    providerId: provider.id,
    name: input.name,
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    ...(input.secretRef === undefined ? {} : { secretRef: input.secretRef }),
    weight: input.weight,
    priority: input.priority,
    enabled: input.enabled,
  });
  return configMutationResponse(
    c,
    "account.create",
    "provider_account",
    account.id,
    {
      providerId: provider.id,
      credential: input.apiKey === undefined ? "secret_ref" : "api_key",
    },
    { data: sanitizeAccount(account) },
    201,
  );
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
    updated.apiKey = input.apiKey;
    delete updated.secretRef;
  }
  if (input.secretRef !== undefined) {
    if (!isValidSecretRef(input.secretRef)) {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "secretRef must be an uppercase Worker Secret name" });
    }
    updated.secretRef = input.secretRef;
    delete updated.apiKey;
  }
  await replaceAccount(c.env.DB, updated);
  return configMutationResponse(
    c,
    "account.update",
    "provider_account",
    account.id,
    { providerId: provider.id },
    { data: sanitizeAccount(updated) },
  );
}

export async function deleteAccountHandler(c: Context<AppEnv>): Promise<Response> {
  const provider = await requireProvider(c, requireProviderId(c));
  const accountId = requireParam(c, "accountId");
  const account = await getAccount(c.env.DB, accountId);
  if (account === undefined || account.providerId !== provider.id) {
    throw new GatewayError({ code: "NOT_FOUND", message: "Provider account not found" });
  }
  await deleteAccount(c.env.DB, account.id);
  return configMutationResponse(
    c,
    "account.delete",
    "provider_account",
    account.id,
    { providerId: provider.id },
    { deleted: true, id: account.id },
  );
}

export async function testProviderHandler(c: Context<AppEnv>): Promise<Response> {
  const provider = await requireProvider(c, requireProviderId(c));
  const startedAt = Date.now();
  const accounts = await listAccounts(c.env.DB, provider.id);
  if (accounts.length === 0) {
    return c.json({
      ok: false,
      providerId: provider.id,
      latencyMs: 0,
      error: {
        code: "PROVIDER_NO_ACCOUNT",
        message: "Provider has no accounts. Add an upstream account before testing.",
      },
    });
  }
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
    const upstreamStatus = gatewayError.details?.["upstream_status"];
    let message = gatewayError.publicMessage;
    if (gatewayError.code === "PROVIDER_UNAVAILABLE") {
      message = "No usable provider account. Check that the account is enabled and its credential is valid.";
    } else if (upstreamStatus === 401 || upstreamStatus === 403) {
      message = "Provider authentication failed. Check the account API key or secretRef.";
    } else if (upstreamStatus === 404 || upstreamStatus === 405) {
      message =
        "The provider does not expose a compatible models endpoint. Create models manually or use the gateway test.";
    }
    return c.json({
      ok: false,
      providerId: provider.id,
      latencyMs: Date.now() - startedAt,
      error: { code: gatewayError.code, message },
    });
  }
}

export async function syncModelsHandler(c: Context<AppEnv>): Promise<Response> {
  const provider = await requireProvider(c, requireProviderId(c));
  const { apiKey } = await selectAnyProviderAccount(c.env, provider.id);
  const result = await syncProviderModels(c.env, provider, apiKey, c.get("fetchImpl"));

  return configMutationResponse(
    c,
    "provider.sync_models",
    "provider",
    provider.id,
    { total: result.total, created: result.created, skipped: result.skipped },
    {
      providerId: provider.id,
      total: result.total,
      created: result.created,
      skipped: result.skipped,
      createdModels: result.createdModels,
      requiresConfirmation: true,
      note: "Synced models are disabled until an administrator confirms their capabilities and enables them.",
    },
  );
}

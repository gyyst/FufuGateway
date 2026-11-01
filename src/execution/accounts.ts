import { GatewayError } from "../core/errors";
import type { RuntimeConfig, ProviderAccountRecord } from "../config/types";
import type { GatewayEnv } from "../env";
import { readSecretRef } from "../security/secrets";
import { listAccounts } from "../config/repository";
import { BreakerClient, accountBreakerKey, breakerOptionsFor } from "./breaker";

/** 解析上游账户密钥：secretRef 优先，否则使用账户内保存的明文 apiKey。 */
export async function resolveAccountApiKey(
  env: GatewayEnv,
  account: ProviderAccountRecord,
): Promise<string> {
  if (account.secretRef !== undefined) {
    const value = readSecretRef(env, account.secretRef);
    if (value !== undefined) return value;
  }
  if (account.apiKey !== undefined) return account.apiKey;
  throw new GatewayError({
    code: "PROVIDER_UNAVAILABLE",
    message: "Provider account has no credential configured",
  });
}

export interface SelectedAccount {
  account: ProviderAccountRecord;
  apiKey: string;
}

/** 管理端/定时任务：直接从 D1 选择一个可用账户（不依赖配置快照）。 */
export async function selectAnyProviderAccount(
  env: GatewayEnv,
  providerId: string,
): Promise<SelectedAccount> {
  const accounts = await listAccounts(env.DB, providerId);
  for (const account of accounts) {
    if (!account.enabled) continue;
    try {
      return { account, apiKey: await resolveAccountApiKey(env, account) };
    } catch {
      // 尝试下一个账户
    }
  }
  throw new GatewayError({
    code: "PROVIDER_UNAVAILABLE",
    message: "No usable provider account",
  });
}

/**
 * 选择一个可用账户：过滤禁用、冷却、熔断中的账户，
 * 在剩余账户间按权重轮询，并解析其凭据。
 */
export async function selectProviderAccount(
  env: GatewayEnv,
  config: RuntimeConfig,
  providerId: string,
  excluded?: ReadonlySet<string>,
): Promise<SelectedAccount> {
  const now = Date.now();
  const provider = config.providersById.get(providerId);
  if (provider === undefined) {
    throw new GatewayError({ code: "PROVIDER_NOT_FOUND", message: "Provider is not configured" });
  }
  const accounts = (config.accountsByProvider.get(providerId) ?? []).filter(
    (account) =>
      account.enabled &&
      (account.cooldownUntil === undefined || account.cooldownUntil <= now) &&
      !(excluded?.has(account.id) ?? false),
  );
  if (accounts.length === 0) {
    throw new GatewayError({
      code: "PROVIDER_UNAVAILABLE",
      message: "No available provider account",
    });
  }

  const breaker = new BreakerClient(env);
  const breakerOptions = breakerOptionsFor(provider);
  const allowed: ProviderAccountRecord[] = [];
  for (const account of accounts) {
    if (await breaker.isAllowed(providerId, accountBreakerKey(account.id), breakerOptions)) {
      allowed.push(account);
    }
  }
  if (allowed.length === 0) {
    throw new GatewayError({
      code: "PROVIDER_UNAVAILABLE",
      message: "All provider accounts are temporarily circuit-open",
      retriable: true,
      details: { breaker: "account" },
    });
  }

  let ordered = allowed;
  if (allowed.length > 1) {
    try {
      const stub = env.COORDINATION.get(
        env.COORDINATION.idFromName(`accounts:${providerId}`),
      );
      const index = await stub.nextWeighted(
        providerId,
        allowed.map((account) => Math.max(1, account.weight)),
      );
      const start = ((index % allowed.length) + allowed.length) % allowed.length;
      ordered = [...allowed.slice(start), ...allowed.slice(0, start)];
    } catch {
      ordered = allowed;
    }
  }

  for (const account of ordered) {
    try {
      const apiKey = await resolveAccountApiKey(env, account);
      return { account, apiKey };
    } catch {
      // 尝试下一个账户；全部失败时统一返回不可用。
    }
  }
  throw new GatewayError({
    code: "PROVIDER_UNAVAILABLE",
    message: "No available provider account",
  });
}

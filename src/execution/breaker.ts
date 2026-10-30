import { asNumber, getRecord } from "../core/json";
import type { ProviderRecord } from "../config/types";
import type { BreakerOptions } from "../durable-objects/coordination";
import type { GatewayEnv } from "../env";

export const DEFAULT_BREAKER_OPTIONS: BreakerOptions = {
  failureThreshold: 3,
  failureRate: 0.5,
  minSamples: 5,
  windowMs: 60_000,
  openMs: 30_000,
  halfOpenProbes: 2,
};

export function breakerOptionsFor(provider: ProviderRecord): BreakerOptions {
  const config = getRecord(provider.extraConfig, "breaker");
  if (config === undefined) return DEFAULT_BREAKER_OPTIONS;
  return {
    failureThreshold: asNumber(config["failureThreshold"]) ?? DEFAULT_BREAKER_OPTIONS.failureThreshold,
    failureRate: asNumber(config["failureRate"]) ?? DEFAULT_BREAKER_OPTIONS.failureRate,
    minSamples: asNumber(config["minSamples"]) ?? DEFAULT_BREAKER_OPTIONS.minSamples,
    windowMs: asNumber(config["windowMs"]) ?? DEFAULT_BREAKER_OPTIONS.windowMs,
    openMs: asNumber(config["openMs"]) ?? DEFAULT_BREAKER_OPTIONS.openMs,
    halfOpenProbes: asNumber(config["halfOpenProbes"]) ?? DEFAULT_BREAKER_OPTIONS.halfOpenProbes,
  };
}

/** 熔断状态客户端；DO 不可用时按“允许”处理，避免阻断流量。 */
export class BreakerClient {
  constructor(private readonly env: GatewayEnv) {}

  private stub(providerId: string) {
    return this.env.COORDINATION.get(
      this.env.COORDINATION.idFromName(`breaker:${providerId}`),
    );
  }

  async isAllowed(providerId: string, key: string, options: BreakerOptions): Promise<boolean> {
    try {
      return await this.stub(providerId).breakerAllow(key, options);
    } catch {
      return true;
    }
  }

  async record(
    providerId: string,
    key: string,
    success: boolean,
    options: BreakerOptions,
  ): Promise<void> {
    try {
      await this.stub(providerId).breakerRecord(key, success, options);
    } catch {
      // 熔断统计失败不影响请求。
    }
  }
}

export function modelBreakerKey(modelRecordId: string): string {
  return `model:${modelRecordId}`;
}

export function accountBreakerKey(accountId: string): string {
  return `account:${accountId}`;
}

import type { GatewayEnv } from "../env";
import type { RateLimitDecision, RateLimitRequest } from "../durable-objects/rate-limiter";

/** 限流客户端；协调层故障时放行，避免整体不可用。 */
export class RateLimiterClient {
  constructor(private readonly env: GatewayEnv) {}

  private stub(owner: string) {
    return this.env.RATE_LIMITER.get(
      this.env.RATE_LIMITER.idFromName(owner),
    );
  }

  async acquire(owner: string, request: RateLimitRequest): Promise<RateLimitDecision> {
    try {
      return await this.stub(owner).acquire(request);
    } catch {
      return { allowed: true };
    }
  }

  async release(owner: string, leaseId: string): Promise<void> {
    try {
      await this.stub(owner).release(leaseId);
    } catch {
      // 租约会在 TTL 后自动过期。
    }
  }

  async adjustTokens(
    owner: string,
    reservedTokens: number,
    actualTokens: number,
    minute?: number,
  ): Promise<void> {
    try {
      await this.stub(owner).adjustTokens(reservedTokens, actualTokens, minute);
    } catch {
      // 统计修正失败不影响请求。
    }
  }

  async recordCost(
    owner: string,
    subjectId: string,
    costUsd: number,
    subjectType: "api_key" | "user" = "api_key",
  ): Promise<void> {
    try {
      await this.stub(owner).recordCost(subjectId, costUsd, subjectType);
    } catch {
      // 预算缓存失败时由 D1 汇总兜底。
    }
  }
}

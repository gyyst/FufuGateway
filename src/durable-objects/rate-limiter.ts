import { DurableObject } from "cloudflare:workers";
import type { GatewayEnv } from "../env";
import { dayKey, monthKey } from "../core/time";

export type RateLimitReason = "rpm" | "tpm" | "concurrency" | "budget_daily" | "budget_monthly";

export interface RateLimitRequest {
  apiKeyId: string;
  subjectType?: "api_key" | "user";
  subjectId?: string;
  rpmLimit?: number;
  tpmLimit?: number;
  concurrencyLimit?: number;
  dailyBudgetUsd?: number;
  monthlyBudgetUsd?: number;
  estimatedTokens: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  reason?: RateLimitReason;
  retryAfterMs?: number;
  leaseId?: string;
  reservedTokens?: number;
  minute?: number;
}

const LEASE_TTL_MS = 10 * 60 * 1000;

function msUntilNextMinute(now: number): number {
  return 60_000 - (now % 60_000);
}

function msUntilNextUtcDay(now: number): number {
  const date = new Date(now);
  const next = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return Math.max(1000, next - now);
}

function msUntilNextUtcMonth(now: number): number {
  const date = new Date(now);
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  return Math.max(1000, next - now);
}

/**
 * 分布式限流与并发控制（每个 API Key 一个实例）。
 *
 * 实例内维护固定分钟窗口的 RPM/TPM、并发租约与预算缓存；
 * 预算首次使用时从 D1 的 budget_counters 播种，避免 DO 重启后绕过预算。
 */
export class RateLimiterDO extends DurableObject<GatewayEnv> {
  async ping(): Promise<{ ok: true; now: number }> {
    return { ok: true, now: Date.now() };
  }

  private async budgetSpend(
    scope: "day" | "month",
    period: string,
    subjectType: "api_key" | "user",
    subjectId: string,
  ): Promise<number> {
    const key = `budget:${scope}:${period}`;
    const cached = await this.ctx.storage.get<number>(key);
    if (cached !== undefined) return cached;
    let spend = 0;
    try {
      const row = await this.env.DB.prepare(
        `SELECT spend_usd FROM budget_counters
         WHERE scope = ? AND subject_type = ? AND subject_id = ? AND period = ?`,
      )
        .bind(scope, subjectType, subjectId, period)
        .first<{ spend_usd: number }>();
      spend = row?.spend_usd ?? 0;
    } catch {
      spend = 0;
    }
    await this.ctx.storage.put(key, spend);
    return spend;
  }

  async acquire(request: RateLimitRequest): Promise<RateLimitDecision> {
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    const day = dayKey(now);
    const month = monthKey(now);
    const estimated = Math.max(0, Math.round(request.estimatedTokens));
    const subjectType = request.subjectType ?? "api_key";
    const subjectId = request.subjectId ?? request.apiKeyId;

    if (request.dailyBudgetUsd !== undefined && request.dailyBudgetUsd > 0) {
      const spend = await this.budgetSpend("day", day, subjectType, subjectId);
      if (spend >= request.dailyBudgetUsd) {
        return { allowed: false, reason: "budget_daily", retryAfterMs: msUntilNextUtcDay(now) };
      }
    }
    if (request.monthlyBudgetUsd !== undefined && request.monthlyBudgetUsd > 0) {
      const spend = await this.budgetSpend("month", month, subjectType, subjectId);
      if (spend >= request.monthlyBudgetUsd) {
        return { allowed: false, reason: "budget_monthly", retryAfterMs: msUntilNextUtcMonth(now) };
      }
    }

    const rpmKey = `rpm:${minute}`;
    if (request.rpmLimit !== undefined && request.rpmLimit > 0) {
      const calls = (await this.ctx.storage.get<number>(rpmKey)) ?? 0;
      if (calls >= request.rpmLimit) {
        return { allowed: false, reason: "rpm", retryAfterMs: msUntilNextMinute(now) };
      }
    }

    const tpmKey = `tpm:${minute}`;
    if (request.tpmLimit !== undefined && request.tpmLimit > 0) {
      const used = (await this.ctx.storage.get<number>(tpmKey)) ?? 0;
      if (used + estimated > request.tpmLimit) {
        return { allowed: false, reason: "tpm", retryAfterMs: msUntilNextMinute(now) };
      }
    }

    let leaseId: string | undefined;
    if (request.concurrencyLimit !== undefined && request.concurrencyLimit > 0) {
      const leases = (await this.ctx.storage.get<Record<string, number>>("leases")) ?? {};
      let active = 0;
      const nextLeases: Record<string, number> = {};
      for (const [id, expiresAt] of Object.entries(leases)) {
        if (expiresAt > now) {
          nextLeases[id] = expiresAt;
          active += 1;
        }
      }
      if (active >= request.concurrencyLimit) {
        await this.ctx.storage.put("leases", nextLeases);
        return { allowed: false, reason: "concurrency", retryAfterMs: 1000 };
      }
      leaseId = crypto.randomUUID();
      nextLeases[leaseId] = now + LEASE_TTL_MS;
      await this.ctx.storage.put("leases", nextLeases);
    }

    if (request.rpmLimit !== undefined && request.rpmLimit > 0) {
      const calls = (await this.ctx.storage.get<number>(rpmKey)) ?? 0;
      await this.ctx.storage.put(rpmKey, calls + 1);
    }
    if (request.tpmLimit !== undefined && request.tpmLimit > 0) {
      const used = (await this.ctx.storage.get<number>(tpmKey)) ?? 0;
      await this.ctx.storage.put(tpmKey, used + estimated);
    }

    return {
      allowed: true,
      ...(leaseId === undefined ? {} : { leaseId }),
      reservedTokens: estimated,
      minute,
    };
  }

  async release(leaseId: string): Promise<void> {
    const leases = (await this.ctx.storage.get<Record<string, number>>("leases")) ?? {};
    if (leases[leaseId] === undefined) return;
    delete leases[leaseId];
    await this.ctx.storage.put("leases", leases);
  }

  /** 根据实际 Usage 修正 TPM 预留量。 */
  async adjustTokens(reservedTokens: number, actualTokens: number, minute?: number): Promise<void> {
    const targetMinute = minute ?? Math.floor(Date.now() / 60_000);
    const key = `tpm:${targetMinute}`;
    const used = (await this.ctx.storage.get<number>(key)) ?? 0;
    const next = Math.max(0, used + Math.max(0, Math.round(actualTokens)) - Math.max(0, Math.round(reservedTokens)));
    await this.ctx.storage.put(key, next);
  }

  /** 记录一次实际费用到预算缓存（D1 由 Usage 消费者异步落库）。 */
  async recordCost(
    subjectId: string,
    costUsd: number,
    subjectType: "api_key" | "user" = "api_key",
  ): Promise<void> {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return;
    const now = Date.now();
    const day = dayKey(now);
    const month = monthKey(now);
    const daySpend = await this.budgetSpend("day", day, subjectType, subjectId);
    const monthSpend = await this.budgetSpend("month", month, subjectType, subjectId);
    await this.ctx.storage.put("budget:day:" + day, daySpend + costUsd);
    await this.ctx.storage.put("budget:month:" + month, monthSpend + costUsd);
  }
}

import type { Context } from "hono";
import type { AppEnv } from "../app";
import { GatewayError } from "../core/errors";
import type { UnifiedRequest } from "../ir";
import type { RateLimitReason } from "../durable-objects/rate-limiter";
import { RateLimiterClient } from "../ratelimit/limiter";

export interface QuotaPart {
  owner: string;
  subjectType: "api_key" | "user";
  subjectId: string;
  leaseId?: string;
  reservedTokens: number;
  minute?: number;
}

export interface QuotaLease {
  parts: QuotaPart[];
}

interface LimitSet {
  rpmLimit?: number;
  tpmLimit?: number;
  concurrencyLimit?: number;
  dailyBudgetUsd?: number;
  monthlyBudgetUsd?: number;
}

function hasLimits(limits: LimitSet): boolean {
  return (
    (limits.rpmLimit !== undefined && limits.rpmLimit > 0) ||
    (limits.tpmLimit !== undefined && limits.tpmLimit > 0) ||
    (limits.concurrencyLimit !== undefined && limits.concurrencyLimit > 0) ||
    (limits.dailyBudgetUsd !== undefined && limits.dailyBudgetUsd > 0) ||
    (limits.monthlyBudgetUsd !== undefined && limits.monthlyBudgetUsd > 0)
  );
}

function countText(request: UnifiedRequest): { chars: number; images: number } {
  let chars = 0;
  let images = 0;
  const countParts = (parts: readonly import("../ir").UnifiedContentPart[]): void => {
    for (const part of parts) {
      if (part.type === "text") chars += part.text.length;
      else if (part.type === "thinking") chars += part.text.length;
      else if (part.type === "refusal") chars += part.text.length;
      else if (part.type === "image") images += 1;
      else if (part.type === "tool_call") chars += JSON.stringify(part.arguments).length;
      else if (part.type === "tool_result") {
        chars += JSON.stringify(part.structured ?? "").length;
        countParts(part.content);
      }
    }
  };

  for (const instruction of request.system) countParts(instruction.content);
  for (const message of request.messages) countParts(message.content);
  for (const tool of request.tools) {
    chars += tool.inputSchema === undefined ? 0 : JSON.stringify(tool.inputSchema).length;
  }
  return { chars, images };
}

/** 粗略估算本次请求占用的 token（输入 + 预计输出）。 */
export function estimateRequestTokens(request: UnifiedRequest): number {
  const { chars, images } = countText(request);
  const input = Math.ceil(chars / 4) + images * 256;
  const output = request.maxOutputTokens ?? 1024;
  return Math.min(2_000_000, Math.max(1, input + output));
}

function limitError(reason: RateLimitReason, retryAfterMs: number | undefined): GatewayError {
  const details = {
    reason,
    ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
  };
  if (reason === "budget_daily" || reason === "budget_monthly") {
    return new GatewayError({
      code: "BUDGET_EXCEEDED",
      message: "Budget exceeded",
      details,
    });
  }
  if (reason === "tpm") {
    return new GatewayError({
      code: "TOKEN_LIMIT_EXCEEDED",
      message: "Token limit exceeded",
      details,
    });
  }
  return new GatewayError({
    code: "REQUEST_LIMIT_EXCEEDED",
    message:
      reason === "concurrency"
        ? "Too many concurrent requests"
        : "Request rate limit exceeded",
    details,
  });
}

async function acquireFor(
  c: Context<AppEnv>,
  owner: string,
  subjectType: "api_key" | "user",
  subjectId: string,
  apiKeyId: string,
  limits: LimitSet,
  estimated: number,
): Promise<QuotaPart | undefined> {
  if (!hasLimits(limits)) return undefined;
  const decision = await new RateLimiterClient(c.env).acquire(owner, {
    apiKeyId,
    subjectType,
    subjectId,
    ...(limits.rpmLimit === undefined ? {} : { rpmLimit: limits.rpmLimit }),
    ...(limits.tpmLimit === undefined ? {} : { tpmLimit: limits.tpmLimit }),
    ...(limits.concurrencyLimit === undefined ? {} : { concurrencyLimit: limits.concurrencyLimit }),
    ...(limits.dailyBudgetUsd === undefined ? {} : { dailyBudgetUsd: limits.dailyBudgetUsd }),
    ...(limits.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: limits.monthlyBudgetUsd }),
    estimatedTokens: estimated,
  });
  if (!decision.allowed) {
    throw limitError(decision.reason ?? "rpm", decision.retryAfterMs);
  }
  return {
    owner,
    subjectType,
    subjectId,
    reservedTokens: decision.reservedTokens ?? estimated,
    ...(decision.leaseId === undefined ? {} : { leaseId: decision.leaseId }),
    ...(decision.minute === undefined ? {} : { minute: decision.minute }),
  };
}

export async function acquireQuota(
  c: Context<AppEnv>,
  request: UnifiedRequest,
): Promise<QuotaLease | undefined> {
  const principal = c.get("principal");
  const key = principal?.apiKey;
  const user = principal?.user;
  if (key === undefined) return undefined;

  const estimated = estimateRequestTokens(request);
  const parts: QuotaPart[] = [];

  const keyPart = await acquireFor(
    c,
    `key:${key.id}`,
    "api_key",
    key.id,
    key.id,
    {
      rpmLimit: key.rpmLimit,
      tpmLimit: key.tpmLimit,
      concurrencyLimit: key.concurrencyLimit,
      dailyBudgetUsd: key.dailyBudgetUsd,
      monthlyBudgetUsd: key.monthlyBudgetUsd,
    },
    estimated,
  );
  if (keyPart !== undefined) parts.push(keyPart);

  if (user !== undefined) {
    try {
      const userPart = await acquireFor(
        c,
        `user:${user.id}`,
        "user",
        user.id,
        key.id,
        {
          rpmLimit: user.rpmLimit,
          tpmLimit: user.tpmLimit,
          concurrencyLimit: user.concurrencyLimit,
          dailyBudgetUsd: user.dailyBudgetUsd,
          monthlyBudgetUsd: user.monthlyBudgetUsd,
        },
        estimated,
      );
      if (userPart !== undefined) parts.push(userPart);
    } catch (error) {
      // 用户级限制拒绝时释放已获取的 Key 级租约。
      await releaseQuota(c, { parts });
      throw error;
    }
  }

  return parts.length === 0 ? undefined : { parts };
}

export async function settleQuota(
  c: Context<AppEnv>,
  lease: QuotaLease | undefined,
  totalTokens: number,
  costUsd: number,
): Promise<void> {
  if (lease === undefined) return;
  const client = new RateLimiterClient(c.env);
  for (const part of lease.parts) {
    await client.adjustTokens(part.owner, part.reservedTokens, totalTokens, part.minute);
    if (costUsd > 0) {
      await client.recordCost(part.owner, part.subjectId, costUsd, part.subjectType);
    }
  }
}

export async function releaseQuota(
  c: Context<AppEnv>,
  lease: QuotaLease | undefined,
): Promise<void> {
  if (lease === undefined) return;
  const client = new RateLimiterClient(c.env);
  for (const part of lease.parts) {
    if (part.leaseId !== undefined) await client.release(part.owner, part.leaseId);
  }
}

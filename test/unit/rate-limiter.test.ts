import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

describe("分布式限流器", () => {
  it("RPM 固定窗口限制", async () => {
    const keyId = "unit-rpm";
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`key:${keyId}`));
    const first = await stub.acquire({ apiKeyId: keyId, rpmLimit: 1, estimatedTokens: 10 });
    expect(first.allowed).toBe(true);
    const second = await stub.acquire({ apiKeyId: keyId, rpmLimit: 1, estimatedTokens: 10 });
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe("rpm");
    expect(second.retryAfterMs).toBeGreaterThan(0);
  });

  it("TPM 预留与修正", async () => {
    const keyId = "unit-tpm";
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`key:${keyId}`));
    const denied = await stub.acquire({ apiKeyId: keyId, tpmLimit: 10, estimatedTokens: 11 });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("tpm");

    const allowed = await stub.acquire({ apiKeyId: keyId, tpmLimit: 100, estimatedTokens: 60 });
    expect(allowed.allowed).toBe(true);
    await stub.adjustTokens(60, 10, allowed.minute);
    const next = await stub.acquire({ apiKeyId: keyId, tpmLimit: 20, estimatedTokens: 5 });
    expect(next.allowed).toBe(true);
  });

  it("并发租约释放后恢复", async () => {
    const keyId = "unit-concurrency";
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`key:${keyId}`));
    const first = await stub.acquire({ apiKeyId: keyId, concurrencyLimit: 1, estimatedTokens: 1 });
    expect(first.allowed).toBe(true);
    expect(first.leaseId).toBeTruthy();

    const second = await stub.acquire({ apiKeyId: keyId, concurrencyLimit: 1, estimatedTokens: 1 });
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe("concurrency");

    await stub.release(first.leaseId ?? "");
    const third = await stub.acquire({ apiKeyId: keyId, concurrencyLimit: 1, estimatedTokens: 1 });
    expect(third.allowed).toBe(true);
  });

  it("预算耗尽后拒绝请求", async () => {
    const keyId = "unit-budget";
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`key:${keyId}`));
    const first = await stub.acquire({ apiKeyId: keyId, dailyBudgetUsd: 1, estimatedTokens: 1 });
    expect(first.allowed).toBe(true);
    await stub.recordCost(keyId, 1.5);
    const second = await stub.acquire({ apiKeyId: keyId, dailyBudgetUsd: 1, estimatedTokens: 1 });
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe("budget_daily");
    expect(second.retryAfterMs).toBeGreaterThan(0);
  });
});

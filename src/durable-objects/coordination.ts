import { DurableObject } from "cloudflare:workers";
import type { GatewayEnv } from "../env";

export interface BreakerOptions {
  failureThreshold: number;
  failureRate: number;
  minSamples: number;
  windowMs: number;
  openMs: number;
  halfOpenProbes: number;
}

export interface BreakerState {
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  windowStart: number;
  windowFailures: number;
  windowTotal: number;
  openedAt: number;
  halfOpenProbes: number;
}

/**
 * 强一致协调状态：轮询游标、加权轮询、会话粘性、延迟 EWMA。
 *
 * 实例按 `combo:{comboId}`（游标 / 加权状态 / 延迟）与
 * `sticky:{sessionHash}`（会话锁）分片；熔断状态在 Phase 6 加入。
 */
export class CoordinationDO extends DurableObject<GatewayEnv> {
  async ping(): Promise<{ ok: true; now: number }> {
    return { ok: true, now: Date.now() };
  }

  /** 原子递增轮询游标，返回取模后的索引。 */
  async nextRoundRobin(comboId: string, modulo: number): Promise<number> {
    if (modulo <= 0) return 0;
    const key = `rr:${comboId}`;
    const current = (await this.ctx.storage.get<number>(key)) ?? 0;
    await this.ctx.storage.put(key, current + 1);
    return current % modulo;
  }

  /** 平滑加权轮询（SWRR），返回本轮选中的索引。 */
  async nextWeighted(comboId: string, weights: number[]): Promise<number> {
    if (weights.length === 0) return 0;
    const key = `wrr:${comboId}`;
    let current = (await this.ctx.storage.get<number[]>(key)) ?? [];
    if (current.length !== weights.length) current = weights.map(() => 0);

    let total = 0;
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < weights.length; index += 1) {
      const weight = Math.max(0, weights[index] ?? 0);
      total += weight;
      const value = (current[index] ?? 0) + weight;
      current[index] = value;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    }
    if (total <= 0) return Math.floor(Math.random() * weights.length);
    current[bestIndex] = (current[bestIndex] ?? 0) - total;
    await this.ctx.storage.put(key, current);
    return bestIndex;
  }

  /** 记录一次延迟样本（EWMA）。 */
  async recordLatency(comboId: string, targetKey: string, latencyMs: number): Promise<void> {
    const key = `lat:${comboId}:${targetKey}`;
    const previous = await this.ctx.storage.get<number>(key);
    const sample = Math.max(0, latencyMs);
    const next = previous === undefined ? sample : previous * 0.7 + sample * 0.3;
    await this.ctx.storage.put(key, next);
  }

  async getLatencies(comboId: string, targetKeys: string[]): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    if (targetKeys.length === 0) return result;
    const keys = targetKeys.map((targetKey) => `lat:${comboId}:${targetKey}`);
    const values = await this.ctx.storage.get<number>(keys);
    targetKeys.forEach((targetKey, index) => {
      const value = values.get(keys[index] ?? "");
      if (typeof value === "number") result[targetKey] = value;
    });
    return result;
  }

  async getSticky(comboId: string): Promise<string | undefined> {
    const key = `sticky:${comboId}`;
    const entry = await this.ctx.storage.get<{ value: string; expiresAt: number }>(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async setSticky(comboId: string, value: string, ttlMs: number): Promise<void> {
    const expiresAt = Date.now() + Math.max(1000, ttlMs);
    await this.ctx.storage.put(`sticky:${comboId}`, { value, expiresAt });
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || expiresAt < currentAlarm) {
      await this.ctx.storage.setAlarm(expiresAt);
    }
  }

  async clearSticky(comboId: string): Promise<void> {
    await this.ctx.storage.delete(`sticky:${comboId}`);
  }

  // -------------------------------------------------------------------------
  // 熔断器
  // -------------------------------------------------------------------------

  async breakerAllow(breakerKey: string, options: BreakerOptions): Promise<boolean> {
    const key = `br:${breakerKey}`;
    const state = (await this.ctx.storage.get<BreakerState>(key)) ?? this.initialBreakerState();
    const now = Date.now();

    if (state.state === "open") {
      if (now - state.openedAt < options.openMs) return false;
      state.state = "half_open";
      state.halfOpenProbes = 1;
      await this.ctx.storage.put(key, state);
      return true;
    }
    if (state.state === "half_open") {
      if (state.halfOpenProbes >= options.halfOpenProbes) return false;
      state.halfOpenProbes += 1;
      await this.ctx.storage.put(key, state);
      return true;
    }
    return true;
  }

  async breakerRecord(breakerKey: string, success: boolean, options: BreakerOptions): Promise<void> {
    const key = `br:${breakerKey}`;
    const state = (await this.ctx.storage.get<BreakerState>(key)) ?? this.initialBreakerState();
    const now = Date.now();

    if (success) {
      if (state.state === "half_open") {
        await this.ctx.storage.put(key, this.initialBreakerState());
        return;
      }
      state.consecutiveFailures = 0;
      state.windowTotal += 1;
      await this.ctx.storage.put(key, state);
      return;
    }

    if (state.state === "half_open") {
      state.state = "open";
      state.openedAt = now;
      state.halfOpenProbes = 0;
      state.consecutiveFailures += 1;
      await this.ctx.storage.put(key, state);
      return;
    }

    if (now - state.windowStart > options.windowMs) {
      state.windowStart = now;
      state.windowFailures = 0;
      state.windowTotal = 0;
    }
    state.consecutiveFailures += 1;
    state.windowFailures += 1;
    state.windowTotal += 1;
    const rate = state.windowTotal === 0 ? 0 : state.windowFailures / state.windowTotal;
    const shouldOpen =
      state.consecutiveFailures >= options.failureThreshold ||
      (state.windowTotal >= options.minSamples && rate >= options.failureRate);
    if (shouldOpen) {
      state.state = "open";
      state.openedAt = now;
      state.halfOpenProbes = 0;
    }
    await this.ctx.storage.put(key, state);
  }

  async breakerState(breakerKey: string): Promise<BreakerState> {
    return (await this.ctx.storage.get<BreakerState>(`br:${breakerKey}`)) ?? this.initialBreakerState();
  }

  private initialBreakerState(): BreakerState {
    return {
      state: "closed",
      consecutiveFailures: 0,
      windowStart: Date.now(),
      windowFailures: 0,
      windowTotal: 0,
      openedAt: 0,
      halfOpenProbes: 0,
    };
  }

  /** 清理过期的会话锁，并安排下一次清理。 */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<{ value: string; expiresAt: number }>({
      prefix: "sticky:",
    });
    let nextExpiry: number | undefined;
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) {
        await this.ctx.storage.delete(key);
      } else if (nextExpiry === undefined || entry.expiresAt < nextExpiry) {
        nextExpiry = entry.expiresAt;
      }
    }
    if (nextExpiry !== undefined) {
      await this.ctx.storage.setAlarm(nextExpiry);
    }
  }
}

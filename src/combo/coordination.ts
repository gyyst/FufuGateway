import type { GatewayEnv } from "../env";

/**
 * Durable Object 协调客户端。所有方法在 DO 不可用时降级为确定性默认值，
 * 避免协调层故障阻断推理请求。
 */
export class CoordinationClient {
  constructor(private readonly env: GatewayEnv) {}

  private comboStub(comboId: string) {
    return this.env.COORDINATION.get(
      this.env.COORDINATION.idFromName(`combo:${comboId}`),
    );
  }

  private stickyStub(sessionHash: string) {
    return this.env.COORDINATION.get(
      this.env.COORDINATION.idFromName(`sticky:${sessionHash}`),
    );
  }

  async nextRoundRobin(comboId: string, modulo: number): Promise<number> {
    try {
      return await this.comboStub(comboId).nextRoundRobin(comboId, modulo);
    } catch {
      return 0;
    }
  }

  async nextWeighted(comboId: string, weights: number[]): Promise<number> {
    try {
      return await this.comboStub(comboId).nextWeighted(comboId, weights);
    } catch {
      if (weights.length === 0) return 0;
      return Math.floor(Math.random() * weights.length);
    }
  }

  async recordLatency(comboId: string, targetKey: string, latencyMs: number): Promise<void> {
    try {
      await this.comboStub(comboId).recordLatency(comboId, targetKey, latencyMs);
    } catch {
      // 延迟统计失败不影响请求。
    }
  }

  async getLatencies(comboId: string, targetKeys: string[]): Promise<Record<string, number>> {
    try {
      return await this.comboStub(comboId).getLatencies(comboId, targetKeys);
    } catch {
      return {};
    }
  }

  async getSticky(sessionHash: string, comboId: string): Promise<string | undefined> {
    try {
      return await this.stickyStub(sessionHash).getSticky(comboId);
    } catch {
      return undefined;
    }
  }

  async setSticky(
    sessionHash: string,
    comboId: string,
    value: string,
    ttlMs: number,
  ): Promise<void> {
    try {
      await this.stickyStub(sessionHash).setSticky(comboId, value, ttlMs);
    } catch {
      // 粘性会话是可选能力，写入失败时退化为非粘性。
    }
  }

  async clearSticky(sessionHash: string, comboId: string): Promise<void> {
    try {
      await this.stickyStub(sessionHash).clearSticky(comboId);
    } catch {
      // 忽略。
    }
  }
}

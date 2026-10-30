import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "../../src/core/errors";
import { sleep } from "../../src/core/time";
import { emptyUsage } from "../../src/ir/usage";
import type { ProviderAccountRecord, ProviderRecord } from "../../src/config/types";
import type { CoordinationClient } from "../../src/combo/coordination";
import type { ResolvedCombo, ResolvedComboNode, ResolvedTarget } from "../../src/combo/types";
import { DEFAULT_RUNTIME_SETTINGS } from "../../src/config/types";
import type {
  ComboTraceNode,
  NodeEvaluation,
  NodeSuccess,
  StrategyContext,
} from "../../src/combo/strategies/types";
import { fallbackStrategy } from "../../src/combo/strategies/fallback";
import { priorityStrategy } from "../../src/combo/strategies/priority";
import { roundRobinStrategy } from "../../src/combo/strategies/round-robin";
import { weightedRoundRobinStrategy } from "../../src/combo/strategies/weighted-round-robin";
import { lowestLatencyStrategy } from "../../src/combo/strategies/lowest-latency";
import { lowestCostStrategy } from "../../src/combo/strategies/lowest-cost";
import { raceStrategy } from "../../src/combo/strategies/race";
import { fusionStrategy } from "../../src/combo/strategies/fusion";

const provider: ProviderRecord = {
  id: "prv",
  name: "mock",
  type: "OPENAI_COMPATIBLE",
  protocol: "openai-chat",
  baseUrl: "https://mock.test",
  enabled: true,
  priority: 100,
  weight: 1,
  customHeaders: {},
  timeoutMs: 60_000,
  firstTokenTimeoutMs: 20_000,
  idleTimeoutMs: 60_000,
  maxRetries: 2,
  retry: null,
  proxyConfig: null,
  extraConfig: {},
  createdAt: 0,
  updatedAt: 0,
};

const account: ProviderAccountRecord = {
  id: "acc",
  providerId: "prv",
  name: "primary",
  weight: 1,
  priority: 100,
  enabled: true,
  healthStatus: "healthy",
  consecutiveFailures: 0,
  createdAt: 0,
  updatedAt: 0,
};

function target(id: string, price = 1): ResolvedTarget {
  return {
    kind: "model",
    providerId: "prv",
    providerName: "mock",
    modelRecordId: `mdl_${id}`,
    modelId: id,
    upstreamModelId: id,
    capabilities: {
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsStream: true,
      supportsTools: true,
      supportsParallelTools: false,
      supportsJsonSchema: false,
      supportsReasoning: false,
      supportsVision: false,
      supportsAudio: false,
      supportsVideo: false,
      supportsPromptCache: false,
    },
    pricing: {
      inputPrice: price,
      outputPrice: price,
      currency: "USD",
      unit: "per_million_tokens",
    },
    weight: 1,
    priority: 100,
  };
}

function node(id: string, options: { weight?: number; priority?: number; price?: number } = {}): ResolvedComboNode {
  return {
    kind: "model",
    target: target(id, options.price ?? 1),
    weight: options.weight ?? 1,
    priority: options.priority ?? 100,
  };
}

function traceFor(label: string): ComboTraceNode {
  const now = Date.now();
  return { id: `t_${label}`, kind: "model", label, status: "failed", startedAt: now, attempts: [], children: [] };
}

function success(forNode: ResolvedComboNode): NodeEvaluation {
  const modelTarget = forNode.kind === "model" ? forNode.target : target("fallback");
  const trace = traceFor(modelTarget.modelId);
  trace.status = "ok";
  const value: NodeSuccess = {
    target: modelTarget,
    provider,
    account,
    response: {
      id: "resp",
      model: modelTarget.modelId,
      createdAt: Date.now(),
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: emptyUsage("upstream"),
    },
    latencyMs: 5,
    issues: [],
    httpStatus: 200,
  };
  return { success: value, trace, node: forNode };
}

function failure(forNode: ResolvedComboNode, retriable: boolean, code = "UPSTREAM_ERROR"): NodeEvaluation {
  const label = forNode.kind === "model" ? forNode.target.modelId : "combo";
  return {
    error: new GatewayError({ code: code as never, message: "failed", retriable }),
    trace: traceFor(label),
    node: forNode,
  };
}

function fakeCoordination(overrides: Partial<CoordinationClient> = {}): CoordinationClient {
  const base = {
    nextRoundRobin: vi.fn(async () => 0),
    nextWeighted: vi.fn(async () => 0),
    recordLatency: vi.fn(async () => undefined),
    getLatencies: vi.fn(async () => ({})),
    getSticky: vi.fn(async () => undefined),
    setSticky: vi.fn(async () => undefined),
    clearSticky: vi.fn(async () => undefined),
  };
  return { ...base, ...overrides } as unknown as CoordinationClient;
}

function combo(nodes: ResolvedComboNode[], overrides: Partial<ResolvedCombo> = {}): ResolvedCombo {
  return {
    id: "combo_test",
    name: "test-combo",
    strategy: "fallback",
    nodes,
    ...overrides,
  };
}

interface ContextOptions {
  coordination?: CoordinationClient;
  preferredKey?: string;
  judge?: (successes: NodeSuccess[]) => Promise<NodeEvaluation>;
}

function context(
  root: ResolvedCombo,
  evaluate: (node: ResolvedComboNode, options: { signal: AbortSignal; deadline: number }) => Promise<NodeEvaluation>,
  options: ContextOptions = {},
): StrategyContext {
  return {
    combo: root,
    nodes: root.nodes,
    signal: new AbortController().signal,
    deadline: Date.now() + 10_000,
    isStream: false,
    ...(options.preferredKey === undefined ? {} : { preferredKey: options.preferredKey }),
    coordination: options.coordination ?? fakeCoordination(),
    maxConcurrency: 4,
    traceChildren: [],
    evaluate,
    judge:
      options.judge ??
      (async () => ({
        error: new GatewayError({ code: "COMBO_EXECUTION_FAILED", message: "judge not configured" }),
        trace: traceFor("judge"),
      })),
  };
}

describe("顺序类策略", () => {
  it("fallback 在可重试错误后切换节点", async () => {
    const nodes = [node("a"), node("b")];
    const calls: string[] = [];
    const evaluate = async (current: ResolvedComboNode): Promise<NodeEvaluation> => {
      const id = current.kind === "model" ? current.target.modelId : "";
      calls.push(id);
      return id === "a" ? failure(current, true) : success(current);
    };
    const ctx = context(combo(nodes), evaluate);
    const result = await fallbackStrategy.run(ctx);
    expect(result.success?.target.modelId).toBe("b");
    expect(calls).toEqual(["a", "b"]);
    expect(ctx.traceChildren).toHaveLength(2);
  });

  it("fallback 遇到不可重试错误立即停止", async () => {
    const nodes = [node("a"), node("b")];
    const calls: string[] = [];
    const evaluate = async (current: ResolvedComboNode): Promise<NodeEvaluation> => {
      const id = current.kind === "model" ? current.target.modelId : "";
      calls.push(id);
      return failure(current, false, "MODEL_NOT_FOUND");
    };
    const result = await fallbackStrategy.run(context(combo(nodes), evaluate));
    expect(result.error?.code).toBe("MODEL_NOT_FOUND");
    expect(calls).toEqual(["a"]);
  });

  it("fallback 优先使用粘性节点", async () => {
    const nodes = [node("a"), node("b")];
    const calls: string[] = [];
    const evaluate = async (current: ResolvedComboNode): Promise<NodeEvaluation> => {
      calls.push(current.kind === "model" ? current.target.modelId : "");
      return success(current);
    };
    await fallbackStrategy.run(
      context(combo(nodes), evaluate, { preferredKey: "model:prv:mdl_b" }),
    );
    expect(calls).toEqual(["b"]);
  });

  it("priority 按优先级降序执行", async () => {
    const nodes = [node("low", { priority: 10 }), node("high", { priority: 100 }), node("mid", { priority: 50 })];
    const calls: string[] = [];
    const evaluate = async (current: ResolvedComboNode): Promise<NodeEvaluation> => {
      calls.push(current.kind === "model" ? current.target.modelId : "");
      return failure(current, true);
    };
    await priorityStrategy.run(context(combo(nodes), evaluate));
    expect(calls).toEqual(["high", "mid", "low"]);
  });

  it("round_robin 使用 DO 游标旋转顺序", async () => {
    const nodes = [node("a"), node("b"), node("c")];
    const calls: string[] = [];
    const coordination = fakeCoordination({ nextRoundRobin: vi.fn(async () => 1) });
    const evaluate = async (current: ResolvedComboNode): Promise<NodeEvaluation> => {
      calls.push(current.kind === "model" ? current.target.modelId : "");
      return failure(current, true);
    };
    await roundRobinStrategy.run(context(combo(nodes), evaluate, { coordination }));
    expect(calls).toEqual(["b", "c", "a"]);
    expect(coordination.nextRoundRobin).toHaveBeenCalledWith("combo_test", 3);
  });

  it("weighted_round_robin 使用权重选择起点", async () => {
    const nodes = [node("a", { weight: 1 }), node("b", { weight: 5 }), node("c", { weight: 2 })];
    const calls: string[] = [];
    const coordination = fakeCoordination({ nextWeighted: vi.fn(async () => 2) });
    const evaluate = async (current: ResolvedComboNode): Promise<NodeEvaluation> => {
      calls.push(current.kind === "model" ? current.target.modelId : "");
      return failure(current, true);
    };
    await weightedRoundRobinStrategy.run(context(combo(nodes), evaluate, { coordination }));
    expect(calls).toEqual(["c", "a", "b"]);
    expect(coordination.nextWeighted).toHaveBeenCalledWith("combo_test", [1, 5, 2]);
  });

  it("lowest_latency 按记录延迟升序选择", async () => {
    const nodes = [node("slow"), node("fast")];
    const calls: string[] = [];
    const coordination = fakeCoordination({
      getLatencies: vi.fn(async () => ({ "prv:mdl_slow": 900, "prv:mdl_fast": 120 })),
    });
    const evaluate = async (current: ResolvedComboNode): Promise<NodeEvaluation> => {
      calls.push(current.kind === "model" ? current.target.modelId : "");
      return failure(current, true);
    };
    await lowestLatencyStrategy.run(context(combo(nodes), evaluate, { coordination }));
    expect(calls).toEqual(["fast", "slow"]);
  });

  it("lowest_cost 按价格升序选择", async () => {
    const nodes = [node("expensive", { price: 10 }), node("cheap", { price: 1 })];
    const calls: string[] = [];
    const evaluate = async (current: ResolvedComboNode): Promise<NodeEvaluation> => {
      calls.push(current.kind === "model" ? current.target.modelId : "");
      return failure(current, true);
    };
    await lowestCostStrategy.run(context(combo(nodes), evaluate));
    expect(calls).toEqual(["cheap", "expensive"]);
  });
});

describe("并行类策略", () => {
  it("race 采用首个成功结果并取消其他请求", async () => {
    const nodes = [node("slow"), node("fast")];
    const aborted: string[] = [];
    const evaluate = async (
      current: ResolvedComboNode,
      options: { signal: AbortSignal },
    ): Promise<NodeEvaluation> => {
      const id = current.kind === "model" ? current.target.modelId : "";
      try {
        await sleep(id === "slow" ? 50 : 5, { signal: options.signal });
      } catch {
        aborted.push(id);
        return failure(current, false, "REQUEST_CANCELLED");
      }
      return success(current);
    };
    const result = await raceStrategy.run(context(combo(nodes, { strategy: "race" }), evaluate));
    expect(result.success?.target.modelId).toBe("fast");
    expect(aborted).toContain("slow");
  });

  it("race 全部失败时返回错误", async () => {
    const nodes = [node("a"), node("b")];
    const evaluate = async (current: ResolvedComboNode): Promise<NodeEvaluation> =>
      failure(current, true);
    const result = await raceStrategy.run(context(combo(nodes, { strategy: "race" }), evaluate));
    expect(result.success).toBeUndefined();
    expect(result.error).toBeDefined();
  });

  it("fusion 调用 judge 处理所有成功结果", async () => {
    const nodes = [node("a"), node("b")];
    let judgeInput: NodeSuccess[] = [];
    const evaluate = async (current: ResolvedComboNode): Promise<NodeEvaluation> => success(current);
    const judge = async (successes: NodeSuccess[]): Promise<NodeEvaluation> => {
      judgeInput = successes;
      return success(nodes[0]!);
    };
    const result = await fusionStrategy.run(
      context(combo(nodes, { strategy: "fusion", judgeTarget: target("judge") }), evaluate, { judge }),
    );
    expect(result.success).toBeDefined();
    expect(judgeInput).toHaveLength(2);
  });

  it("fusion 明确拒绝流式请求", async () => {
    const ctx = context(combo([node("a")], { strategy: "fusion" }), async (current) => success(current));
    await expect(fusionStrategy.run({ ...ctx, isStream: true })).rejects.toBeInstanceOf(GatewayError);
  });
});

describe("默认设置", () => {
  it("默认并发与限制可用", () => {
    expect(DEFAULT_RUNTIME_SETTINGS.maxComboConcurrency).toBe(8);
    expect(DEFAULT_RUNTIME_SETTINGS.maxComboDepth).toBe(16);
  });
});

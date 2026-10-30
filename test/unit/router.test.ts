import { describe, expect, it } from "vitest";
import { GatewayError } from "../../src/core/errors";
import { buildRuntimeConfig } from "../../src/config/runtime";
import {
  DEFAULT_RUNTIME_SETTINGS,
  type ConfigSnapshotData,
  type ModelRecord,
  type ProviderRecord,
  type RuntimeConfig,
} from "../../src/config/types";
import { ModelRouter } from "../../src/router/resolver";

const NOW = 1_700_000_000_000;

function provider(id: string, name: string, overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id,
    name,
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://api.example.com/v1",
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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function model(providerId: string, modelId: string, overrides: Partial<ModelRecord> = {}): ModelRecord {
  const upstreamModelId = overrides.upstreamModelId ?? modelId;
  return {
    id: `mdl_${providerId}_${modelId}`.replace(/[^A-Za-z0-9_]/g, "_"),
    providerId,
    modelId,
    upstreamModelId,
    inputModalities: ["text"],
    outputModalities: ["text"],
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
    pricing: { inputPrice: 1, outputPrice: 2, currency: "USD", unit: "per_million_tokens" },
    enabled: true,
    source: "manual",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function baseData(overrides: Partial<ConfigSnapshotData> = {}): ConfigSnapshotData {
  return {
    providers: [],
    accounts: [],
    models: [],
    aliases: [],
    wildcards: [],
    combos: [],
    pricing: [],
    settings: DEFAULT_RUNTIME_SETTINGS,
    ...overrides,
  };
}

function runtime(data: ConfigSnapshotData): RuntimeConfig {
  return buildRuntimeConfig(data, { version: 1, checksum: "test", createdAt: NOW, source: "kv" });
}

function expectGatewayError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code} but no error was thrown`);
}

describe("模型路由优先级", () => {
  const config = runtime(
    baseData({
      providers: [provider("p1", "openai"), provider("p2", "backup")],
      models: [
        model("p1", "gpt-5"),
        model("p1", "claude-x"),
        model("p2", "claude-x"),
        model("p2", "gemini-2.5-pro"),
      ],
      aliases: [
        {
          id: "als_1",
          name: "best-model",
          target: "openai/gpt-5",
          enabled: true,
          priority: 100,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "als_2",
          name: "loop-a",
          target: { alias: "loop-b" },
          enabled: true,
          priority: 100,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "als_3",
          name: "loop-b",
          target: { alias: "loop-a" },
          enabled: true,
          priority: 100,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      wildcards: [
        {
          id: "wld_1",
          pattern: "claude-*",
          strategy: "fallback",
          targets: ["openai/claude-x"],
          priority: 10,
          enabled: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "wld_2",
          pattern: "claude-sonnet-*",
          strategy: "fallback",
          targets: ["backup/gemini-2.5-pro"],
          priority: 10,
          enabled: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      combos: [
        {
          id: "cmb_1",
          name: "coding-combo",
          strategy: "fallback",
          nodes: ["openai/gpt-5", "backup/gemini-2.5-pro"],
          enabled: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    }),
  );
  const router = new ModelRouter(config);

  it("唯一原生模型直接路由", () => {
    const result = router.resolve("gpt-5");
    expect(result.match.type).toBe("native");
    expect(result.plan.kind).toBe("models");
    if (result.plan.kind === "models") {
      expect(result.plan.targets).toHaveLength(1);
      expect(result.plan.targets[0]?.providerId).toBe("p1");
      expect(result.plan.targets[0]?.upstreamModelId).toBe("gpt-5");
    }
  });

  it("同名模型返回歧义错误", () => {
    expectGatewayError(() => router.resolve("claude-x"), "MODEL_AMBIGUOUS");
  });

  it("Provider 前缀严格路由", () => {
    const result = router.resolve("openai/claude-x");
    expect(result.match.type).toBe("provider_prefix");
    if (result.plan.kind === "models") {
      expect(result.plan.targets[0]?.providerId).toBe("p1");
    }
    expectGatewayError(() => router.resolve("openai/missing-model"), "MODEL_NOT_FOUND");
    expectGatewayError(() => router.resolve("unknown-provider/gpt-5"), "MODEL_NOT_FOUND");
  });

  it("Alias 精确匹配", () => {
    const result = router.resolve("best-model");
    expect(result.match.type).toBe("alias");
    if (result.plan.kind === "models") {
      expect(result.plan.targets[0]?.modelId).toBe("gpt-5");
    }
  });

  it("Alias 循环引用被检测", () => {
    expectGatewayError(() => router.resolve("loop-a"), "CONFIG_INVALID");
  });

  it("原生模型优先于通配符", () => {
    const result = router.resolve("gemini-2.5-pro");
    expect(result.match.type).toBe("native");
  });

  it("同优先级下更具体的通配符优先", () => {
    const result = router.resolve("claude-sonnet-4");
    expect(result.match.type).toBe("wildcard");
    if (result.match.type === "wildcard") {
      expect(result.match.pattern).toBe("claude-sonnet-*");
    }
  });

  it("未匹配模型返回 MODEL_NOT_FOUND", () => {
    expectGatewayError(() => router.resolve("unknown-model"), "MODEL_NOT_FOUND");
  });

  it("Combo 名称精确匹配", () => {
    const result = router.resolve("coding-combo");
    expect(result.match.type).toBe("combo");
    expect(result.plan.kind).toBe("combo");
  });

  it("权限白名单按 Provider 过滤", () => {
    const result = router.resolve("openai/claude-x", { allowedProviderIds: ["p1"] });
    expect(result.plan.kind).toBe("models");
    expectGatewayError(
      () => router.resolve("openai/claude-x", { allowedProviderIds: ["p2"] }),
      "PERMISSION_DENIED",
    );
  });

  it("权限白名单按模型过滤", () => {
    expectGatewayError(
      () => router.resolve("gpt-5", { allowedModelIds: ["claude-x"] }),
      "PERMISSION_DENIED",
    );
    const allowed = router.resolve("gpt-5", { allowedModelIds: ["gpt-5"] });
    expect(allowed.plan.kind).toBe("models");
  });
});

describe("通配符虚拟模型", () => {
  it("多目标按策略返回", () => {
    const router = new ModelRouter(
      runtime(
        baseData({
          providers: [provider("p1", "p1"), provider("p2", "p2")],
          models: [model("p1", "m1"), model("p2", "m2")],
          wildcards: [
            {
              id: "wld_multi",
              pattern: "virtual-*",
              strategy: "weighted_round_robin",
              targets: ["p1/m1", "p2/m2"],
              priority: 100,
              enabled: true,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      ),
    );
    const result = router.resolve("virtual-x");
    expect(result.plan.kind).toBe("models");
    if (result.plan.kind === "models") {
      expect(result.plan.strategy).toBe("weighted_round_robin");
      expect(result.plan.targets.map((target) => target.providerId)).toEqual(["p1", "p2"]);
    }
  });

  it("通配符可以映射到 Combo 并生成内联组合", () => {
    const router = new ModelRouter(
      runtime(
        baseData({
          providers: [provider("p1", "p1")],
          models: [model("p1", "m1")],
          combos: [
            {
              id: "cmb_x",
              name: "inner",
              strategy: "fallback",
              nodes: ["p1/m1"],
              enabled: true,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
          wildcards: [
            {
              id: "wld_mix",
              pattern: "mix-*",
              strategy: "race",
              targets: ["p1/m1", { combo: "inner" }],
              priority: 100,
              enabled: true,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      ),
    );
    const result = router.resolve("mix-x");
    expect(result.plan.kind).toBe("inline_combo");
    if (result.plan.kind === "inline_combo") {
      expect(result.plan.strategy).toBe("race");
      expect(result.plan.nodes.some((node) => node.kind === "model")).toBe(true);
      expect(result.plan.nodes.some((node) => node.kind === "combo" && node.comboName === "inner")).toBe(true);
    }
  });

  it("优先级高于具体度", () => {
    const router = new ModelRouter(
      runtime(
        baseData({
          providers: [provider("p1", "p1"), provider("p2", "p2")],
          models: [model("p1", "m1"), model("p2", "m2")],
          wildcards: [
            {
              id: "wld_specific",
              pattern: "claude-sonnet-*",
              strategy: "fallback",
              targets: ["p2/m2"],
              priority: 5,
              enabled: true,
              createdAt: NOW,
              updatedAt: NOW,
            },
            {
              id: "wld_general",
              pattern: "claude-*",
              strategy: "fallback",
              targets: ["p1/m1"],
              priority: 50,
              enabled: true,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      ),
    );
    const result = router.resolve("claude-sonnet-4");
    if (result.match.type === "wildcard") {
      expect(result.match.pattern).toBe("claude-*");
    }
  });
});

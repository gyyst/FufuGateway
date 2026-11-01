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
      combos: [
        {
          id: "cmb_glob_1",
          name: "claude-*",
          strategy: "fallback",
          nodes: ["openai/claude-x"],
          priority: 10,
          enabled: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "cmb_glob_2",
          name: "claude-sonnet-*",
          strategy: "fallback",
          nodes: ["backup/gemini-2.5-pro"],
          priority: 10,
          enabled: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "cmb_1",
          name: "coding-combo",
          strategy: "fallback",
          nodes: ["openai/gpt-5", "backup/gemini-2.5-pro"],
          priority: 100,
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

  it("旧别名合成为单节点 Combo", () => {
    const result = router.resolve("best-model");
    expect(result.match.type).toBe("combo");
    expect(result.plan.kind).toBe("combo");
  });

  it("原生模型优先于通配符", () => {
    const result = router.resolve("gemini-2.5-pro");
    expect(result.match.type).toBe("native");
  });

  it("同优先级下更具体的 glob Combo 优先", () => {
    const result = router.resolve("claude-sonnet-4");
    expect(result.match.type).toBe("combo_glob");
    if (result.match.type === "combo_glob") {
      expect(result.match.pattern).toBe("claude-sonnet-*");
    }
  });

  it("精确 Combo 优先于 glob Combo", () => {
    const exact = new ModelRouter(
      runtime(
        baseData({
          providers: [provider("openai", "openai")],
          models: [model("openai", "claude-x")],
          combos: [
            {
              id: "cmb_exact",
              name: "claude-sonnet-4",
              strategy: "fallback",
              nodes: ["openai/claude-x"],
              priority: 100,
              enabled: true,
              createdAt: NOW,
              updatedAt: NOW,
            },
            {
              id: "cmb_glob",
              name: "claude-*",
              strategy: "fallback",
              nodes: ["openai/claude-x"],
              priority: 1000,
              enabled: true,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      ),
    ).resolve("claude-sonnet-4");
    expect(exact.match.type).toBe("combo");
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

describe("glob Combo 虚拟模型", () => {
  it("多目标按策略返回", () => {
    const router = new ModelRouter(
      runtime(
        baseData({
          providers: [provider("p1", "p1"), provider("p2", "p2")],
          models: [model("p1", "m1"), model("p2", "m2")],
          combos: [
            {
              id: "cmb_multi",
              name: "virtual-*",
              strategy: "weighted_round_robin",
              nodes: ["p1/m1", "p2/m2"],
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
    expect(result.match.type).toBe("combo_glob");
    expect(result.plan.kind).toBe("combo");
    if (result.plan.kind === "combo") {
      expect(result.plan.combo.strategy).toBe("weighted_round_robin");
      expect(result.plan.combo.nodes).toHaveLength(2);
    }
  });

  it("glob Combo 可以映射到其他 Combo", () => {
    const router = new ModelRouter(
      runtime(
        baseData({
          providers: [provider("p1", "p1")],
          models: [model("p1", "m1")],
          combos: [
            {
              id: "cmb_inner",
              name: "inner",
              strategy: "fallback",
              nodes: ["p1/m1"],
              priority: 100,
              enabled: true,
              createdAt: NOW,
              updatedAt: NOW,
            },
            {
              id: "cmb_mix",
              name: "mix-*",
              strategy: "race",
              nodes: ["p1/m1", { combo: "inner" }],
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
    expect(result.plan.kind).toBe("combo");
    if (result.plan.kind === "combo") {
      expect(result.plan.combo.strategy).toBe("race");
      expect(
        result.plan.combo.nodes.some(
          (node) => typeof node === "object" && node.combo === "inner",
        ),
      ).toBe(true);
    }
  });

  it("优先级高于具体度", () => {
    const router = new ModelRouter(
      runtime(
        baseData({
          providers: [provider("p1", "p1"), provider("p2", "p2")],
          models: [model("p1", "m1"), model("p2", "m2")],
          combos: [
            {
              id: "cmb_specific",
              name: "claude-sonnet-*",
              strategy: "fallback",
              nodes: ["p2/m2"],
              priority: 5,
              enabled: true,
              createdAt: NOW,
              updatedAt: NOW,
            },
            {
              id: "cmb_general",
              name: "claude-*",
              strategy: "fallback",
              nodes: ["p1/m1"],
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
    expect(result.match.type).toBe("combo_glob");
    if (result.match.type === "combo_glob") {
      expect(result.match.pattern).toBe("claude-*");
    }
  });

  it("旧 wildcard 目标按 glob Combo 解析", () => {
    const router = new ModelRouter(
      runtime(
        baseData({
          providers: [provider("p1", "p1")],
          models: [model("p1", "m1")],
          combos: [
            {
              id: "cmb_legacy",
              name: "legacy-*",
              strategy: "fallback",
              nodes: ["p1/m1"],
              priority: 100,
              enabled: true,
              createdAt: NOW,
              updatedAt: NOW,
            },
            {
              id: "cmb_uses_legacy",
              name: "uses-legacy",
              strategy: "fallback",
              nodes: [{ wildcard: "legacy-*" }],
              priority: 100,
              enabled: true,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      ),
    );
    const result = router.resolve("uses-legacy");
    expect(result.plan.kind).toBe("combo");
  });
});
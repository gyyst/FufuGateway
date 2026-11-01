import { describe, expect, it } from "vitest";
import { GatewayError } from "../../src/core/errors";
import { buildRuntimeConfig } from "../../src/config/runtime";
import {
  DEFAULT_RUNTIME_SETTINGS,
  type ComboRecord,
  type ConfigSnapshotData,
  type ModelRecord,
  type ProviderRecord,
  type RuntimeConfig,
} from "../../src/config/types";
import { buildResolvedRoute } from "../../src/combo/normalize";
import { ModelRouter } from "../../src/router/resolver";

const NOW = 1_700_000_000_000;

function provider(id: string, name: string): ProviderRecord {
  return {
    id,
    name,
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://example.test/v1",
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
  };
}

function model(providerId: string, modelId: string): ModelRecord {
  return {
    id: `mdl_${providerId}_${modelId}`.replace(/[^A-Za-z0-9_]/g, "_"),
    providerId,
    modelId,
    upstreamModelId: modelId,
    inputModalities: ["text"],
    outputModalities: ["text"],
    capabilities: {
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsStream: true,
      supportsTools: false,
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
  };
}

function combo(name: string, nodes: ComboRecord["nodes"], overrides: Partial<ComboRecord> = {}): ComboRecord {
  return {
    id: `cmb_${name}`,
    name,
    strategy: "fallback",
    nodes,
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
    priority: overrides.priority ?? 100,
  };
}

function runtime(data: Partial<ConfigSnapshotData>, settings = DEFAULT_RUNTIME_SETTINGS): RuntimeConfig {
  return buildRuntimeConfig(
    {
      providers: [provider("p1", "openai"), provider("p2", "backup")],
      accounts: [],
      models: [model("p1", "m1"), model("p2", "m2")],
      aliases: [],
      wildcards: [],
      combos: [],
      pricing: [],
      settings,
      ...data,
    },
    { version: 1, checksum: "x", createdAt: NOW, source: "kv" },
  );
}

function resolve(config: RuntimeConfig, modelName: string) {
  const router = new ModelRouter(config);
  const resolution = router.resolve(modelName);
  return buildResolvedRoute(resolution.plan, config, router, {
    maxDepth: config.settings.maxComboDepth,
    maxNodes: config.settings.maxComboNodes,
  });
}

describe("Combo 归一化", () => {
  it("展开嵌套 Combo 并保留节点元数据", () => {
    const config = runtime({
      combos: [
        combo("inner", ["openai/m1"]),
        combo("outer", [
          { model: "backup/m2", weight: 3, priority: 7, timeoutMs: 500 },
          { combo: "inner" },
        ]),
      ],
    });
    const root = resolve(config, "outer");
    expect(root.nodes).toHaveLength(2);
    const first = root.nodes[0];
    expect(first?.kind).toBe("model");
    if (first?.kind === "model") {
      expect(first.target.modelId).toBe("m2");
      expect(first.weight).toBe(3);
      expect(first.priority).toBe(7);
      expect(first.timeoutMs).toBe(500);
    }
    const second = root.nodes[1];
    expect(second?.kind).toBe("combo");
    if (second?.kind === "combo") {
      expect(second.combo.name).toBe("inner");
      expect(second.combo.nodes[0]?.kind).toBe("model");
    }
  });

  it("Alias 指向 Combo 时直接展开", () => {
    const config = runtime({
      aliases: [
        {
          id: "als",
          name: "virtual",
          target: { combo: "inner" },
          enabled: true,
          priority: 100,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      combos: [combo("inner", ["openai/m1"])],
    });
    const root = resolve(config, "virtual");
    expect(root.name).toBe("inner");
    expect(root.nodes[0]?.kind).toBe("model");
  });

  it("glob Combo 节点展开为内联组合", () => {
    const config = runtime({
      combos: [
        {
          id: "cmb_glob",
          name: "claude-*",
          strategy: "weighted_round_robin",
          nodes: ["openai/m1", "backup/m2"],
          priority: 100,
          enabled: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
        combo("wc", [{ combo: "claude-*" }]),
      ],
    });
    const root = resolve(config, "wc");
    expect(root.nodes).toHaveLength(1);
    const node = root.nodes[0];
    expect(node?.kind).toBe("combo");
    if (node?.kind === "combo") {
      expect(node.combo.name).toBe("claude-*");
      expect(node.combo.strategy).toBe("weighted_round_robin");
      expect(node.combo.nodes).toHaveLength(2);
    }
  });

  it("旧 wildcard 节点仍按 glob Combo 解析", () => {
    const config = runtime({
      combos: [
        {
          id: "cmb_glob",
          name: "claude-*",
          strategy: "weighted_round_robin",
          nodes: ["openai/m1", "backup/m2"],
          priority: 100,
          enabled: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
        combo("wc", [{ wildcard: "claude-*" }]),
      ],
    });
    const root = resolve(config, "wc");
    expect(root.nodes).toHaveLength(1);
  });

  it("循环引用在归一化阶段被拒绝", () => {
    const config = runtime({
      combos: [
        combo("a", [{ combo: "b" }]),
        combo("b", [{ combo: "a" }]),
      ],
    });
    try {
      resolve(config, "a");
      throw new Error("expected cycle error");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe("COMBO_CYCLE_DETECTED");
    }
  });

  it("超过最大嵌套深度被拒绝", () => {
    const settings = { ...DEFAULT_RUNTIME_SETTINGS, maxComboDepth: 2 };
    const config = runtime(
      {
        combos: [
          combo("c1", [{ combo: "c2" }]),
          combo("c2", [{ combo: "c3" }]),
          combo("c3", [{ combo: "c4" }]),
          combo("c4", ["openai/m1"]),
        ],
      },
      settings,
    );
    try {
      resolve(config, "c1");
      throw new Error("expected depth error");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe("COMBO_EXECUTION_FAILED");
    }
  });

  it("超过最大节点数被拒绝", () => {
    const settings = { ...DEFAULT_RUNTIME_SETTINGS, maxComboNodes: 3 };
    const config = runtime(
      {
        combos: [
          combo("wide", [
            "openai/m1",
            "backup/m2",
            "openai/m1",
            "backup/m2",
          ]),
        ],
      },
      settings,
    );
    try {
      resolve(config, "wide");
      throw new Error("expected node limit error");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe("COMBO_EXECUTION_FAILED");
    }
  });

  it("Fusion 缺少 Judge Model 时拒绝执行", () => {
    const config = runtime({
      combos: [combo("fuse", ["openai/m1"], { strategy: "fusion" })],
    });
    try {
      resolve(config, "fuse");
      throw new Error("expected judge error");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe("CONFIG_INVALID");
    }
  });
});

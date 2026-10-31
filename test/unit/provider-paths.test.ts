import { describe, expect, it } from "vitest";
import type { ProviderRecord } from "../../src/config/types";
import {
  buildProtocolEndpoint,
  buildProtocolModelsEndpoint,
  buildProviderAuth,
} from "../../src/providers/transport";

function provider(
  baseUrl: string,
  overrides: Partial<ProviderRecord> = {},
): ProviderRecord {
  return {
    id: "prv_test",
    name: "test",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl,
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
    ...overrides,
  };
}

function chatPath(baseUrl: string): string {
  return buildProtocolEndpoint(provider(baseUrl), "openai-chat", {
    stream: false,
    upstreamModel: "test-model",
  }).pathname;
}

describe("Provider URL 版本路径", () => {
  it.each([
    ["https://api.openai.com", "/v1/chat/completions"],
    ["https://api.openai.com/v1", "/v1/chat/completions"],
    ["https://ark.cn-beijing.volces.com/api/v3", "/api/v3/chat/completions"],
    ["https://api.modelarts-maas.com/openai/v1", "/openai/v1/chat/completions"],
    ["https://open.bigmodel.cn/api/paas/v4", "/api/paas/v4/chat/completions"],
    ["https://openrouter.ai/api/v1", "/api/v1/chat/completions"],
    ["https://dashscope.aliyuncs.com/compatible-mode/v1", "/compatible-mode/v1/chat/completions"],
  ])("%s -> %s", (baseUrl, expected) => {
    expect(chatPath(baseUrl)).toBe(expected);
  });

  it("不会重复追加版本段", () => {
    expect(chatPath("https://ark.test/api/v3")).not.toContain("/api/v3/v1/");
    expect(chatPath("https://huawei.test/openai/v1")).not.toContain("/openai/v1/v1/");
  });

  it("模型列表复用版本路径规则", () => {
    expect(
      buildProtocolModelsEndpoint(provider("https://ark.test/api/v3"), "openai-chat").pathname,
    ).toBe("/api/v3/models");
    expect(
      buildProtocolModelsEndpoint(provider("https://api.modelarts-maas.com/openai/v1"), "openai-chat")
        .pathname,
    ).toBe("/openai/v1/models");
    expect(
      buildProtocolModelsEndpoint(provider("https://api.openai.com"), "openai-chat").pathname,
    ).toBe("/v1/models");
  });

  it("endpointPath 覆盖优先", () => {
    const custom = provider("https://relay.test/api", {
      extraConfig: { endpointPath: "/custom/chat/{model}" },
    });
    const url = buildProtocolEndpoint(custom, "openai-chat", {
      stream: false,
      upstreamModel: "model-a",
    });
    expect(url.pathname).toBe("/api/custom/chat/model-a");
  });

  it("自定义 Anthropic 上游仍带 anthropic-version", () => {
    const custom = provider("https://ark.test/api/compatible", {
      type: "CUSTOM",
      protocol: "anthropic",
      extraConfig: { authMode: "bearer" },
    });
    const auth = buildProviderAuth(custom, "secret");
    expect(auth.headers["authorization"]).toBe("Bearer secret");
    expect(auth.headers["anthropic-version"]).toBe("2023-06-01");
  });
});

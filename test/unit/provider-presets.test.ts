import { describe, expect, it } from "vitest";
import { getProviderPreset, listProviderPresets } from "../../src/providers/presets";

const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

describe("Provider 预设", () => {
  const presets = listProviderPresets();

  it("预设 ID 与建议名称唯一", () => {
    expect(new Set(presets.map((preset) => preset.id)).size).toBe(presets.length);
    expect(new Set(presets.map((preset) => preset.suggestedName)).size).toBe(presets.length);
  });

  it("每个预设都有可用字段", () => {
    for (const preset of presets) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
      expect(preset.suggestedName).toMatch(PROVIDER_NAME);
      expect(preset.type).toBeTruthy();
      expect(preset.protocol).toBeTruthy();
      if (preset.baseUrl !== "") {
        expect(new URL(preset.baseUrl).protocol).toBe("https:");
      }
    }
  });

  it("火山方舟 OpenAI 与 Anthropic 使用不同 Base URL", () => {
    const openai = getProviderPreset("volcengine-ark-openai");
    const anthropic = getProviderPreset("volcengine-ark-anthropic");
    expect(openai?.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/v3");
    expect(anthropic?.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/compatible");
    expect(openai?.baseUrl).not.toBe(anthropic?.baseUrl);
    expect(anthropic?.extraConfig?.["authMode"]).toBe("bearer");
  });

  it("华为云 MaaS 预设使用 OpenAI 兼容 Base URL", () => {
    expect(getProviderPreset("huawei-maas-openai")?.baseUrl).toBe(
      "https://api.modelarts-maas.com/openai/v1",
    );
  });

  it("自定义预设不强制 Base URL", () => {
    expect(getProviderPreset("custom-openai")?.baseUrl).toBe("");
    expect(getProviderPreset("custom-anthropic")?.baseUrl).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import {
  GeminiTransport,
  OpenAITransport,
  type RemoteModel,
} from "../../src/providers/transport";

const openai = new OpenAITransport();
const gemini = new GeminiTransport();

function only(models: RemoteModel[]): RemoteModel {
  expect(models).toHaveLength(1);
  const model = models[0];
  if (model === undefined) throw new Error("expected one model");
  return model;
}

describe("上游 /models 元数据解析", () => {
  it("解析 OpenRouter 风格字段并换算价格", () => {
    const model = only(
      openai.parseModels({
        data: [
          {
            id: "openai/gpt-5.4",
            name: "GPT-5.4",
            context_length: 400_000,
            top_provider: { context_length: 400_000, max_completion_tokens: 128_000 },
            architecture: {
              input_modalities: ["text", "image", "file"],
              output_modalities: ["text"],
              modality: "text+image->text",
            },
            pricing: {
              prompt: "0.0000025",
              completion: "0.00001",
              input_cache_read: "0.00000025",
            },
            supported_parameters: ["tools", "structured_outputs", "reasoning"],
          },
        ],
      }),
    );
    expect(model.id).toBe("openai/gpt-5.4");
    expect(model.displayName).toBe("GPT-5.4");
    expect(model.contextWindow).toBe(400_000);
    expect(model.maxOutputTokens).toBe(128_000);
    expect(model.inputModalities).toEqual(["text", "image", "file"]);
    expect(model.outputModalities).toEqual(["text"]);
    expect(model.supportsVision).toBe(true);
    expect(model.supportsTools).toBe(true);
    expect(model.supportsJsonSchema).toBe(true);
    expect(model.supportsReasoning).toBe(true);
    expect(model.pricing).toMatchObject({
      inputPrice: 2.5,
      outputPrice: 10,
      cachedInputPrice: 0.25,
    });
  });

  it("解析火山方舟风格的 modalities 字段", () => {
    const model = only(
      openai.parseModels({
        data: [
          {
            id: "doubao-seed-1-8-251228",
            modalities: { input: ["text", "image"], output: ["text"] },
            context_length: 256_000,
            max_output_tokens: 64_000,
            supports_vision: true,
          },
        ],
      }),
    );
    expect(model.contextWindow).toBe(256_000);
    expect(model.maxOutputTokens).toBe(64_000);
    expect(model.inputModalities).toEqual(["text", "image"]);
    expect(model.outputModalities).toEqual(["text"]);
    expect(model.supportsVision).toBe(true);
  });

  it("忽略非法类型与负数", () => {
    const model = only(
      openai.parseModels({
        data: [
          {
            id: "weird-model",
            context_length: "not-a-number",
            max_output_tokens: -1,
            modalities: { input: ["text", "unknown"], output: ["unknown"] },
            pricing: { prompt: "-1", completion: "NaN" },
            tool_call: "yes",
          },
        ],
      }),
    );
    expect(model.contextWindow).toBeUndefined();
    expect(model.maxOutputTokens).toBeUndefined();
    expect(model.inputModalities).toEqual(["text"]);
    expect(model.outputModalities).toBeUndefined();
    expect(model.pricing).toBeUndefined();
    expect(model.supportsTools).toBeUndefined();
  });

  it("标准 OpenAI 列表只保留基础字段", () => {
    const model = only(
      openai.parseModels({
        data: [{ id: "gpt-4o-mini", object: "model", created: 1_700_000_000 }],
      }),
    );
    expect(model.id).toBe("gpt-4o-mini");
    expect(model.createdAt).toBe(1_700_000_000_000);
    expect(model.contextWindow).toBeUndefined();
    expect(model.inputModalities).toBeUndefined();
  });

  it("Gemini 解析上下文与输出上限", () => {
    const model = only(
      gemini.parseModels({
        models: [
          {
            name: "models/gemini-3.8-flash",
            displayName: "Gemini 3.8 Flash",
            inputTokenLimit: 1_048_576,
            outputTokenLimit: 65_536,
          },
        ],
      }),
    );
    expect(model.id).toBe("gemini-3.8-flash");
    expect(model.displayName).toBe("Gemini 3.8 Flash");
    expect(model.contextWindow).toBe(1_048_576);
    expect(model.maxOutputTokens).toBe(65_536);
  });
});

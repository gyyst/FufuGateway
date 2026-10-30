import { describe, expect, it } from "vitest";
import { GatewayError } from "../../src/core/errors";
import type { CompatibilityIssue, ProtocolId, UnifiedRequest, UnifiedResponse } from "../../src/ir";
import { protocolRegistry } from "../../src/protocol/registry";
import type { ProtocolAdapter } from "../../src/protocol/types";

const IMAGE_DATA = "iVBORw0KGgo=";

const TOOL_SCHEMA = {
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
};

interface SourceCase {
  protocol: ProtocolId;
  adapter: ProtocolAdapter;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

const OPENAI_CHAT_REQUEST = {
  model: "source-model",
  messages: [
    { role: "system", content: "You are concise." },
    {
      role: "user",
      content: [
        { type: "text", text: "Hello" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${IMAGE_DATA}` } },
      ],
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "result-1" },
    { role: "user", content: "Continue" },
  ],
  tools: [{ type: "function", function: { name: "lookup", description: "Lookup", parameters: TOOL_SCHEMA } }],
  tool_choice: "auto",
  temperature: 0.5,
  max_tokens: 256,
};

const ANTHROPIC_REQUEST = {
  model: "source-model",
  max_tokens: 256,
  system: "You are concise.",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Hello" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE_DATA } },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "result-1" },
        { type: "text", text: "Continue" },
      ],
    },
  ],
  tools: [{ name: "lookup", description: "Lookup", input_schema: TOOL_SCHEMA }],
  temperature: 0.5,
};

const RESPONSES_REQUEST = {
  model: "source-model",
  instructions: "You are concise.",
  input: [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Hello" },
        { type: "input_image", image_url: `data:image/png;base64,${IMAGE_DATA}` },
      ],
    },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
    { type: "function_call_output", call_id: "call_1", output: "result-1" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
  ],
  tools: [{ type: "function", name: "lookup", description: "Lookup", parameters: TOOL_SCHEMA }],
  max_output_tokens: 256,
  temperature: 0.5,
};

const GEMINI_REQUEST = {
  contents: [
    {
      role: "user",
      parts: [
        { text: "Hello" },
        { inlineData: { mimeType: "image/png", data: IMAGE_DATA } },
      ],
    },
    { role: "model", parts: [{ functionCall: { name: "lookup", args: { q: "x" } } }] },
    {
      role: "user",
      parts: [
        { functionResponse: { name: "lookup", response: { result: "result-1" } } },
        { text: "Continue" },
      ],
    },
  ],
  systemInstruction: { parts: [{ text: "You are concise." }] },
  tools: [{ functionDeclarations: [{ name: "lookup", description: "Lookup", parameters: TOOL_SCHEMA }] }],
  generationConfig: { temperature: 0.5, maxOutputTokens: 256 },
};

const OPENAI_CHAT_RESPONSE = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "source-model",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Answer",
        reasoning_content: "reasoning",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 2 },
    completion_tokens_details: { reasoning_tokens: 3 },
  },
};

const ANTHROPIC_RESPONSE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "source-model",
  content: [
    { type: "thinking", thinking: "reasoning", signature: "sig" },
    { type: "text", text: "Answer" },
    { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: {
    input_tokens: 8,
    output_tokens: 5,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 0,
  },
};

const RESPONSES_RESPONSE = {
  id: "resp_1",
  object: "response",
  created_at: 1_700_000_000,
  status: "completed",
  model: "source-model",
  output: [
    {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "reasoning" }],
      encrypted_content: "sig",
    },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer" }] },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
  ],
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 3 },
  },
};

const GEMINI_RESPONSE = {
  candidates: [
    {
      content: {
        role: "model",
        parts: [
          { text: "reasoning", thought: true, thoughtSignature: "sig" },
          { text: "Answer" },
          { functionCall: { name: "lookup", args: { q: "x" } } },
        ],
      },
      finishReason: "STOP",
      index: 0,
    },
  ],
  usageMetadata: {
    promptTokenCount: 10,
    candidatesTokenCount: 5,
    totalTokenCount: 15,
    cachedContentTokenCount: 2,
    thoughtsTokenCount: 3,
  },
  modelVersion: "source-model",
  responseId: "gemini_1",
};

const SOURCE_CASES: SourceCase[] = [
  {
    protocol: "openai-chat",
    adapter: protocolRegistry.get("openai-chat"),
    request: OPENAI_CHAT_REQUEST,
    response: OPENAI_CHAT_RESPONSE,
  },
  {
    protocol: "anthropic",
    adapter: protocolRegistry.get("anthropic"),
    request: ANTHROPIC_REQUEST,
    response: ANTHROPIC_RESPONSE,
  },
  {
    protocol: "openai-responses",
    adapter: protocolRegistry.get("openai-responses"),
    request: RESPONSES_REQUEST,
    response: RESPONSES_RESPONSE,
  },
  {
    protocol: "gemini",
    adapter: protocolRegistry.get("gemini"),
    request: GEMINI_REQUEST,
    response: GEMINI_RESPONSE,
  },
];

function parseSourceRequest(source: SourceCase): UnifiedRequest {
  return source.adapter.parseRequest(source.request, { model: "source-model", requestId: "req_test" });
}

function parseSourceResponse(source: SourceCase): UnifiedResponse {
  return source.adapter.parseResponse(source.response, { model: "source-model", requestId: "req_test" });
}

describe("协议请求交叉转换（4 x 4）", () => {
  for (const source of SOURCE_CASES) {
    describe(`源协议 ${source.protocol}`, () => {
      it("解析到统一 IR 并保留系统提示、图片、工具调用与工具结果", () => {
        const ir = parseSourceRequest(source);
        expect(ir.model).toBe("source-model");
        expect(ir.system.length).toBeGreaterThan(0);
        expect(JSON.stringify(ir.system)).toContain("You are concise.");
        expect(ir.tools.map((tool) => tool.name)).toContain("lookup");
        expect(ir.messages.some((m) => m.content.some((p) => p.type === "image"))).toBe(true);
        expect(ir.messages.some((m) => m.content.some((p) => p.type === "tool_call"))).toBe(true);
        expect(ir.messages.some((m) => m.content.some((p) => p.type === "tool_result"))).toBe(true);
      });

      for (const target of protocolRegistry.list()) {
        it(`转换为 ${target.id} 上游请求`, () => {
          const ir = parseSourceRequest(source);
          const issues: CompatibilityIssue[] = [];
          const body = target.buildUpstreamRequest(ir, {
            upstreamModel: "upstream-model",
            policy: "warn",
            issues,
          });
          const serialized = JSON.stringify(body);
          if (target.id !== "gemini") {
            expect(serialized).toContain("upstream-model");
          }
          expect(serialized).toContain("You are concise.");
          expect(serialized).toContain("Hello");
          expect(serialized).toContain("lookup");
          expect(serialized).toContain(IMAGE_DATA);
          expect(Array.isArray(issues)).toBe(true);
        });
      }
    });
  }
});

describe("协议响应交叉转换（4 x 4）", () => {
  for (const source of SOURCE_CASES) {
    describe(`源协议 ${source.protocol}`, () => {
      it("解析上游响应并归一化 Usage 与结束原因", () => {
        const ir = parseSourceResponse(source);
        expect(ir.content.some((part) => part.type === "text" && part.text === "Answer")).toBe(true);
        expect(ir.content.some((part) => part.type === "tool_call" && part.name === "lookup")).toBe(true);
        expect(ir.content.some((part) => part.type === "thinking")).toBe(true);
        expect(ir.usage.inputTokens).toBe(10);
        expect(ir.usage.outputTokens).toBe(5);
        expect(ir.usage.cachedInputTokens).toBe(2);
        if (source.protocol === "anthropic") {
          // Anthropic 不返回 reasoning token 计数。
          expect(ir.usage.reasoningTokens).toBeUndefined();
        } else {
          expect(ir.usage.reasoningTokens).toBe(3);
        }
        expect(ir.stopReason).toBe("tool_use");
      });

      for (const target of protocolRegistry.list()) {
        it(`渲染为 ${target.id} 客户端响应`, () => {
          const ir = parseSourceResponse(source);
          const issues: CompatibilityIssue[] = [];
          const rendered = target.renderResponse(ir, {
            requestId: "req_test",
            model: "source-model",
            created: 1_700_000_000_000,
            policy: "warn",
            issues,
          });
          expect(rendered.status).toBe(200);
          const text = rendered.body as string;
          expect(text).toContain("Answer");
          expect(text).toContain("lookup");

          const body = JSON.parse(text) as Record<string, unknown>;
          if (target.id === "openai-chat") {
            const choices = body["choices"] as Array<Record<string, unknown>>;
            const message = choices[0]?.["message"] as Record<string, unknown>;
            expect(choices[0]?.["finish_reason"]).toBe("tool_calls");
            expect(message["reasoning_content"]).toBe("reasoning");
            expect((body["usage"] as Record<string, unknown>)["prompt_tokens"]).toBe(10);
          } else if (target.id === "anthropic") {
            expect(body["stop_reason"]).toBe("tool_use");
            const content = body["content"] as Array<Record<string, unknown>>;
            const hasSignedThinking = content.some(
              (block) => block["type"] === "thinking" && block["signature"] === "sig",
            );
            const hasTextReasoning = content.some(
              (block) => block["type"] === "text" && block["text"] === "reasoning",
            );
            if (source.protocol === "openai-chat") {
              // OpenAI Chat 的 reasoning_content 没有签名，Anthropic 只能降级为文本。
              expect(hasSignedThinking).toBe(false);
              expect(hasTextReasoning).toBe(true);
            } else {
              expect(hasSignedThinking).toBe(true);
            }
            expect(
              content.some((block) => block["type"] === "tool_use" && block["name"] === "lookup"),
            ).toBe(true);
            const usage = body["usage"] as Record<string, unknown>;
            expect(usage["input_tokens"]).toBe(8);
            expect(usage["cache_read_input_tokens"]).toBe(2);
          } else if (target.id === "openai-responses") {
            expect(body["status"]).toBe("completed");
            const output = body["output"] as Array<Record<string, unknown>>;
            expect(output.some((item) => item["type"] === "reasoning")).toBe(true);
            expect(
              output.some((item) => item["type"] === "function_call" && item["name"] === "lookup"),
            ).toBe(true);
            expect((body["usage"] as Record<string, unknown>)["input_tokens"]).toBe(10);
          } else {
            const candidates = body["candidates"] as Array<Record<string, unknown>>;
            const content = candidates[0]?.["content"] as Record<string, unknown>;
            const parts = content["parts"] as Array<Record<string, unknown>>;
            expect(candidates[0]?.["finishReason"]).toBe("STOP");
            expect(parts.some((part) => part["thought"] === true)).toBe(true);
            expect(parts.some((part) => typeof part["functionCall"] === "object")).toBe(true);
            expect((body["usageMetadata"] as Record<string, unknown>)["promptTokenCount"]).toBe(10);
          }
        });
      }
    });
  }
});

describe("参数兼容策略", () => {
  it("STRICT 对无法表达的参数报错", () => {
    const ir = protocolRegistry.get("openai-chat").parseRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_object" },
    });
    const issues: CompatibilityIssue[] = [];
    expect(() =>
      protocolRegistry.get("anthropic").buildUpstreamRequest(ir, {
        upstreamModel: "claude-test",
        policy: "strict",
        issues,
      }),
    ).toThrowError(GatewayError);
  });

  it("WARN 记录丢弃项并继续转换", () => {
    const ir = protocolRegistry.get("anthropic").parseRequest({
      model: "m",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      top_k: 5,
    });
    const issues: CompatibilityIssue[] = [];
    const body = protocolRegistry.get("openai-chat").buildUpstreamRequest(ir, {
      upstreamModel: "gpt-test",
      policy: "warn",
      issues,
    });
    expect(body["model"]).toBe("gpt-test");
    expect(issues.some((issue) => issue.feature === "top_k" && issue.action === "dropped")).toBe(true);
  });

  it("PASSTHROUGH 同协议保留未映射字段", () => {
    const ir = protocolRegistry.get("openai-chat").parseRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      custom_vendor_field: { nested: true },
    });
    const body = protocolRegistry.get("openai-chat").buildUpstreamRequest(ir, {
      upstreamModel: "upstream-model",
      policy: "passthrough",
      issues: [],
    });
    expect(body["model"]).toBe("upstream-model");
    expect(body["custom_vendor_field"]).toEqual({ nested: true });
  });
});

describe("错误转换", () => {
  it("上游 429 归一化为可重试速率限制错误", () => {
    const error = protocolRegistry.get("openai-chat").parseUpstreamError(429, {
      error: { message: "slow down", type: "rate_limit_error", code: "rate_limit_exceeded" },
    });
    expect(error.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(error.retriable).toBe(true);
    expect(error.upstreamStatus).toBe(429);
  });

  it("上游 401 不暴露凭据错误细节且不可重试", () => {
    const error = protocolRegistry.get("anthropic").parseUpstreamError(401, {
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key: sk-secret" },
    });
    expect(error.code).toBe("UPSTREAM_ERROR");
    expect(error.retriable).toBe(false);
    expect(JSON.stringify(error)).not.toContain("sk-secret");
  });

  it("Gemini 错误渲染包含 Google 状态", () => {
    const rendered = protocolRegistry.get("gemini").renderError(
      new GatewayError({ code: "AUTHENTICATION_ERROR", message: "bad key" }),
      { requestId: "req_test", model: "gm", created: Date.now(), policy: "warn", issues: [] },
    );
    const body = JSON.parse(rendered.body as string) as { error: { status: string; code: number } };
    expect(body.error.status).toBe("UNAUTHENTICATED");
    expect(body.error.code).toBe(401);
  });
});

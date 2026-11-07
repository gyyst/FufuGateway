import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  anthropicMessageResponse,
  createHarness,
  geminiStreamFrames,
  jsonResponse,
  openAIChatStreamFrames,
  openAIResponsesStreamFrames,
  sseResponse,
} from "./support";

const harness = createHarness();
let key = "";

beforeAll(async () => {
  const user = await harness.createUser({ displayName: "Protocol Features User" });
  key = (await harness.createApiKey(user.id, { name: "features-key" })).key;

  const chatProvider = await harness.createProvider({
    name: "feat-chat",
    baseUrl: "https://chat-up.test/v1",
  });
  await harness.createAccount(chatProvider.id, { apiKey: "feat-chat-key" });
  await harness.createModel({
    providerId: chatProvider.id,
    modelId: "feat-chat-model",
    upstreamModelId: "feat-chat-up",
    supportsTools: true,
    supportsVision: true,
  });

  const responsesProvider = await harness.createProvider({
    name: "feat-resp",
    protocol: "openai-responses",
    baseUrl: "https://resp-up.test/v1",
  });
  await harness.createAccount(responsesProvider.id, { apiKey: "feat-resp-key" });
  await harness.createModel({
    providerId: responsesProvider.id,
    modelId: "feat-resp-model",
    upstreamModelId: "feat-resp-up",
  });

  const anthropicProvider = await harness.createProvider({
    name: "feat-anth",
    type: "ANTHROPIC",
    protocol: "anthropic",
    baseUrl: "https://anth-up.test",
  });
  await harness.createAccount(anthropicProvider.id, { apiKey: "feat-anth-key" });
  await harness.createModel({
    providerId: anthropicProvider.id,
    modelId: "feat-anth-model",
    upstreamModelId: "feat-anth-up",
    supportsVision: true,
    supportsTools: true,
  });

  const geminiProvider = await harness.createProvider({
    name: "feat-gem",
    type: "GOOGLE_GEMINI",
    protocol: "gemini",
    baseUrl: "https://gem-up.test",
  });
  await harness.createAccount(geminiProvider.id, { apiKey: "feat-gem-key" });
  await harness.createModel({
    providerId: geminiProvider.id,
    modelId: "feat-gem-model",
    upstreamModelId: "feat-gem-up",
  });

  await harness.publish("protocol features");
});

beforeEach(() => {
  harness.upstreamRequests.length = 0;
  harness.setUpstream(() =>
    jsonResponse({ error: { message: "unexpected upstream call", type: "server_error" } }, 500),
  );
});

function chat(model: string, body: Record<string, unknown> = {}): Promise<Response> {
  return harness.call("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], ...body }),
  });
}

describe("流式协议特性", () => {
  it("OpenAI Responses 客户端从 OpenAI Chat 上游收到 Responses 事件流", async () => {
    harness.setUpstream(() =>
      sseResponse(openAIChatStreamFrames("pong", { input: 3, output: 2 })),
    );

    const response = await harness.call("/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "feat-chat/feat-chat-model",
        input: "ping",
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-fufu-stream")).toBe("1");

    const text = await response.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain('"delta":"po"');
    expect(text).toContain('"delta":"ng"');
    expect(text).toContain("event: response.completed");
    expect(text).toContain('"input_tokens":3');
    expect(text).toContain('"output_tokens":2');

    expect(harness.upstreamRequests).toHaveLength(1);
    const upstreamBody = (await harness.upstreamRequests[0]?.json()) as {
      model: string;
      stream: boolean;
    };
    expect(upstreamBody.model).toBe("feat-chat-up");
    expect(upstreamBody.stream).toBe(true);
  });

  it("OpenAI Responses 客户端从 OpenAI Responses 上游收到原生事件流", async () => {
    harness.setUpstream(() =>
      sseResponse(openAIResponsesStreamFrames("pong", { input: 4, output: 5 })),
    );

    const response = await harness.call("/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "feat-resp/feat-resp-model",
        input: "ping",
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain('"delta":"po"');
    expect(text).toContain('"delta":"ng"');
    expect(text).toContain("event: response.completed");
    expect(text).toContain('"input_tokens":4');
    expect(text).toContain('"output_tokens":5');

    const upstream = harness.upstreamRequests[0];
    expect(new URL(upstream?.url ?? "").pathname).toBe("/v1/responses");
  });

  it("Gemini 客户端从 Gemini 上游收到原生 SSE 并请求 alt=sse", async () => {
    harness.setUpstream(() => sseResponse(geminiStreamFrames("pong", { input: 8, output: 9 })));

    const response = await harness.call(
      "/v1beta/models/feat-gem/feat-gem-model:streamGenerateContent",
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }] }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain('"text":"po"');
    expect(text).toContain('"text":"ng"');
    expect(text).toContain('"finishReason":"STOP"');
    expect(text).toContain('"promptTokenCount":8');
    expect(text).toContain('"candidatesTokenCount":9');

    const upstream = harness.upstreamRequests[0];
    const url = new URL(upstream?.url ?? "");
    expect(url.pathname).toBe("/v1beta/models/feat-gem-up:streamGenerateContent");
    expect(url.searchParams.get("alt")).toBe("sse");
    expect(upstream?.headers.get("x-goog-api-key")).toBe("feat-gem-key");
  });
});

describe("推理辅助能力", () => {
  it("Anthropic count_tokens 本地估算且不请求上游", async () => {
    const response = await harness.call("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        model: "feat-anth/feat-anth-model",
        system: "You are a helpful assistant.",
        messages: [{ role: "user", content: "Explain token counting in one sentence." }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-fufu-usage-source")).toBe("estimated");
    const body = (await response.json()) as { input_tokens: number };
    expect(body.input_tokens).toBeGreaterThan(0);
    expect(harness.upstreamRequests).toHaveLength(0);
  });

  it("OpenAI Chat 工具调用可完整往返", async () => {
    harness.setUpstream(() =>
      jsonResponse({
        id: "chatcmpl-tool",
        object: "chat.completion",
        created: 1_700_000_000,
        model: "feat-chat-up",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_weather",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"Paris"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      }),
    );

    const response = await chat("feat-chat/feat-chat-model", {
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get current weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
      tool_choice: "auto",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      choices: Array<{
        finish_reason: string;
        message: {
          content: string | null;
          tool_calls: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };
    const choice = body.choices[0];
    expect(choice?.finish_reason).toBe("tool_calls");
    expect(choice?.message.content).toBeNull();
    expect(choice?.message.tool_calls[0]?.id).toBe("call_weather");
    expect(choice?.message.tool_calls[0]?.function.name).toBe("get_weather");
    expect(JSON.parse(choice?.message.tool_calls[0]?.function.arguments ?? "{}")).toEqual({
      city: "Paris",
    });

    const upstreamBody = (await harness.upstreamRequests[0]?.json()) as {
      tools: Array<{ function: { name: string } }>;
      tool_choice: string;
    };
    expect(upstreamBody.tools[0]?.function.name).toBe("get_weather");
    expect(upstreamBody.tool_choice).toBe("auto");
  });

  it("OpenAI Chat 图片消息转换为 Anthropic base64 图片", async () => {
    harness.setUpstream(() => anthropicMessageResponse("image-ok", { input: 10, output: 1 }));

    const response = await chat("feat-anth/feat-anth-model", {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,aGVsbG8=" },
            },
          ],
        },
      ],
    });

    expect(response.status).toBe(200);
    const upstreamBody = (await harness.upstreamRequests[0]?.json()) as {
      messages: Array<{
        content: Array<{
          type: string;
          source?: { type: string; media_type: string; data: string };
        }>;
      }>;
    };
    const image = upstreamBody.messages[0]?.content.find((part) => part.type === "image");
    expect(image?.source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: "aGVsbG8=",
    });
  });

  it("跨协议不支持的能力通过 x-fufu-warnings 暴露并被丢弃", async () => {
    harness.setUpstream(() => anthropicMessageResponse("json-ok", { input: 5, output: 2 }));

    const response = await chat("feat-anth/feat-anth-model", {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
          },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-fufu-warnings")).toContain("response_format:dropped");

    const upstreamText = await harness.upstreamRequests[0]?.text();
    expect(upstreamText).not.toContain("response_format");
    expect(upstreamText).not.toContain("json_schema");
  });
});

describe("协议错误格式", () => {
  const cases = [
    {
      name: "OpenAI Chat",
      path: "/v1/chat/completions",
      auth: "bearer",
      body: { model: "missing-model", messages: [{ role: "user", content: "ping" }] },
      assert(body: Record<string, unknown>) {
        const error = body["error"] as { code: string };
        expect(error.code).toBe("MODEL_NOT_FOUND");
      },
    },
    {
      name: "OpenAI Responses",
      path: "/v1/responses",
      auth: "bearer",
      body: { model: "missing-model", input: "ping" },
      assert(body: Record<string, unknown>) {
        const error = body["error"] as { code: string };
        expect(error.code).toBe("MODEL_NOT_FOUND");
      },
    },
    {
      name: "Anthropic Messages",
      path: "/v1/messages",
      auth: "x-api-key",
      body: { model: "missing-model", max_tokens: 16, messages: [{ role: "user", content: "ping" }] },
      assert(body: Record<string, unknown>) {
        expect(body["type"]).toBe("error");
        const error = body["error"] as { type: string };
        expect(error.type).toBe("not_found_error");
      },
    },
    {
      name: "Gemini",
      path: "/v1beta/models/missing-model:generateContent",
      auth: "x-goog-api-key",
      body: { contents: [{ role: "user", parts: [{ text: "ping" }] }] },
      assert(body: Record<string, unknown>) {
        const error = body["error"] as { code: number; status: string };
        expect(error.code).toBe(404);
        expect(error.status).toBe("NOT_FOUND");
      },
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} 客户端收到协议原生错误结构`, async () => {
      const headers = {
        "content-type": "application/json",
        ...(testCase.auth === "bearer"
          ? { authorization: `Bearer ${key}` }
          : { [testCase.auth]: key }),
      };
      const response = await harness.call(testCase.path, {
        method: "POST",
        headers,
        body: JSON.stringify(testCase.body),
      });

      expect(response.status).toBe(404);
      testCase.assert((await response.json()) as Record<string, unknown>);
      expect(harness.upstreamRequests).toHaveLength(0);
    });
  }
});

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  anthropicMessageResponse,
  createHarness,
  geminiContentResponse,
  openAIChatCompletionResponse,
  openAIResponsesResponse,
  type WireUsage,
} from "./support";

interface Upstream {
  key: "chat" | "responses" | "anthropic" | "gemini";
  label: string;
  providerName: string;
  modelId: string;
  upstreamModelId: string;
  upstreamKey: string;
  baseUrl: string;
  type: string;
  protocol: string;
  text: string;
  usage: WireUsage;
  expectedPath: string;
  authHeader: "bearer" | "anthropic" | "gemini";
}

const UPSTREAMS: Upstream[] = [
  {
    key: "chat",
    label: "OpenAI Chat",
    providerName: "matrix-chat",
    modelId: "matrix-chat-model",
    upstreamModelId: "matrix-chat-upstream",
    upstreamKey: "chat-upstream-key",
    baseUrl: "https://chat-up.test/v1",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    text: "chat-up-text",
    usage: { input: 3, output: 2 },
    expectedPath: "/v1/chat/completions",
    authHeader: "bearer",
  },
  {
    key: "responses",
    label: "OpenAI Responses",
    providerName: "matrix-resp",
    modelId: "matrix-resp-model",
    upstreamModelId: "matrix-resp-upstream",
    upstreamKey: "resp-upstream-key",
    baseUrl: "https://resp-up.test/v1",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-responses",
    text: "resp-up-text",
    usage: { input: 4, output: 5 },
    expectedPath: "/v1/responses",
    authHeader: "bearer",
  },
  {
    key: "anthropic",
    label: "Anthropic Messages",
    providerName: "matrix-anth",
    modelId: "matrix-anth-model",
    upstreamModelId: "matrix-anth-upstream",
    upstreamKey: "anth-upstream-key",
    baseUrl: "https://anth-up.test",
    type: "ANTHROPIC",
    protocol: "anthropic",
    text: "anth-up-text",
    usage: { input: 6, output: 7 },
    expectedPath: "/v1/messages",
    authHeader: "anthropic",
  },
  {
    key: "gemini",
    label: "Gemini",
    providerName: "matrix-gem",
    modelId: "matrix-gem-model",
    upstreamModelId: "matrix-gem-upstream",
    upstreamKey: "gem-upstream-key",
    baseUrl: "https://gem-up.test",
    type: "GOOGLE_GEMINI",
    protocol: "gemini",
    text: "gem-up-text",
    usage: { input: 8, output: 9 },
    expectedPath: "/v1beta/models/matrix-gem-upstream:generateContent",
    authHeader: "gemini",
  },
];

interface Downstream {
  key: "chat" | "responses" | "anthropic" | "gemini";
  label: string;
  request(model: string, key: string): { path: string; init: RequestInit };
  extractText(body: Record<string, unknown>): string;
  extractUsage(body: Record<string, unknown>): { input: number; output: number };
}

const DOWNSTREAMS: Downstream[] = [
  {
    key: "chat",
    label: "OpenAI Chat",
    request(model, key) {
      return {
        path: "/v1/chat/completions",
        init: {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 32,
          }),
        },
      };
    },
    extractText(body) {
      const choices = body["choices"] as Array<{ message: { content: string } }>;
      return choices[0]?.message.content ?? "";
    },
    extractUsage(body) {
      const usage = body["usage"] as { prompt_tokens: number; completion_tokens: number };
      return { input: usage.prompt_tokens, output: usage.completion_tokens };
    },
  },
  {
    key: "responses",
    label: "OpenAI Responses",
    request(model, key) {
      return {
        path: "/v1/responses",
        init: {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model, input: "ping", max_output_tokens: 32 }),
        },
      };
    },
    extractText(body) {
      return typeof body["output_text"] === "string" ? body["output_text"] : "";
    },
    extractUsage(body) {
      const usage = body["usage"] as { input_tokens: number; output_tokens: number };
      return { input: usage.input_tokens, output: usage.output_tokens };
    },
  },
  {
    key: "anthropic",
    label: "Anthropic Messages",
    request(model, key) {
      return {
        path: "/v1/messages",
        init: {
          method: "POST",
          headers: { "x-api-key": key, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            max_tokens: 32,
            messages: [{ role: "user", content: "ping" }],
          }),
        },
      };
    },
    extractText(body) {
      const content = body["content"] as Array<{ type: string; text?: string }>;
      return content.find((part) => part.type === "text")?.text ?? "";
    },
    extractUsage(body) {
      const usage = body["usage"] as { input_tokens: number; output_tokens: number };
      return { input: usage.input_tokens, output: usage.output_tokens };
    },
  },
  {
    key: "gemini",
    label: "Gemini",
    request(model, key) {
      return {
        path: `/v1beta/models/${model}:generateContent`,
        init: {
          method: "POST",
          headers: { "x-goog-api-key": key, "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "ping" }] }],
          }),
        },
      };
    },
    extractText(body) {
      const candidates = body["candidates"] as Array<{
        content: { parts: Array<{ text?: string }> };
      }>;
      return candidates[0]?.content.parts.find((part) => typeof part.text === "string")?.text ?? "";
    },
    extractUsage(body) {
      const usage = body["usageMetadata"] as {
        promptTokenCount: number;
        candidatesTokenCount: number;
      };
      return { input: usage.promptTokenCount, output: usage.candidatesTokenCount };
    },
  },
];

const harness = createHarness();
let downstreamKey = "";

beforeAll(async () => {
  const user = await harness.createUser({ displayName: "Protocol Matrix User" });
  const key = await harness.createApiKey(user.id, { name: "matrix-key" });
  downstreamKey = key.key;

  for (const upstream of UPSTREAMS) {
    const provider = await harness.createProvider({
      name: upstream.providerName,
      type: upstream.type,
      protocol: upstream.protocol,
      baseUrl: upstream.baseUrl,
    });
    await harness.createAccount(provider.id, {
      name: "primary",
      apiKey: upstream.upstreamKey,
    });
    await harness.createModel({
      providerId: provider.id,
      modelId: upstream.modelId,
      upstreamModelId: upstream.upstreamModelId,
      supportsStream: true,
      supportsTools: true,
    });
  }

  await harness.publish("protocol matrix");
});

beforeEach(() => {
  harness.upstreamRequests.length = 0;
  harness.setUpstream((request) => {
    const host = new URL(request.url).hostname;
    const upstream = UPSTREAMS.find((entry) => new URL(entry.baseUrl).hostname === host);
    if (upstream === undefined) {
      return new Response(JSON.stringify({ error: { message: "unexpected upstream host" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    switch (upstream.key) {
      case "chat":
        return openAIChatCompletionResponse(upstream.text, upstream.usage);
      case "responses":
        return openAIResponsesResponse(upstream.text, upstream.usage);
      case "anthropic":
        return anthropicMessageResponse(upstream.text, upstream.usage);
      case "gemini":
        return geminiContentResponse(upstream.text, upstream.usage);
      default:
        throw new Error(`Unhandled upstream protocol: ${upstream.key satisfies never}`);
    }
  });
});

for (const upstream of UPSTREAMS) {
  describe(`${upstream.label} 上游`, () => {
    for (const downstream of DOWNSTREAMS) {
      it(`${downstream.label} 客户端请求成功并正确映射内容与 Usage`, async () => {
        const requestedModel = `${upstream.providerName}/${upstream.modelId}`;
        const { path, init } = downstream.request(requestedModel, downstreamKey);
        const response = await harness.call(path, init);

        expect(response.status).toBe(200);
        expect(response.headers.get("x-fufu-provider")).toBe(upstream.providerName);

        const body = (await response.json()) as Record<string, unknown>;
        expect(downstream.extractText(body)).toBe(upstream.text);
        expect(downstream.extractUsage(body)).toEqual({
          input: upstream.usage.input,
          output: upstream.usage.output,
        });

        expect(harness.upstreamRequests).toHaveLength(1);
        const upstreamRequest = harness.upstreamRequests[0];
        expect(upstreamRequest).toBeDefined();
        const url = new URL(upstreamRequest?.url ?? "");

        if (upstream.key === "gemini") {
          expect(url.pathname).toBe(`/v1beta/models/${upstream.upstreamModelId}:generateContent`);
          expect(upstreamRequest?.headers.get("x-goog-api-key")).toBe(upstream.upstreamKey);
          expect(upstreamRequest?.headers.get("authorization")).toBeNull();
        } else {
          expect(url.pathname).toBe(upstream.expectedPath);
          const upstreamBody = (await upstreamRequest?.json()) as { model?: string };
          expect(upstreamBody.model).toBe(upstream.upstreamModelId);
        }

        if (upstream.authHeader === "bearer") {
          expect(upstreamRequest?.headers.get("authorization")).toBe(
            `Bearer ${upstream.upstreamKey}`,
          );
        }
        if (upstream.authHeader === "anthropic") {
          expect(upstreamRequest?.headers.get("x-api-key")).toBe(upstream.upstreamKey);
          expect(upstreamRequest?.headers.get("authorization")).toBeNull();
          expect(upstreamRequest?.headers.get("anthropic-version")).toBe("2023-06-01");
        }
        if (upstream.authHeader === "gemini") {
          expect(upstreamRequest?.headers.get("x-goog-api-key")).toBe(upstream.upstreamKey);
        }
      });
    }
  });
}

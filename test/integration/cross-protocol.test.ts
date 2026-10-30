import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { generateApiKey } from "../../src/auth/api-key";
import { createApiKeyRecord, createUser } from "../../src/auth/repository";
import type { FetchLike } from "../../src/providers/types";

const ADMIN_TOKEN = "test-admin-token";
let downstreamKey = "";
const upstreamRequests: Request[] = [];

function anthroResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_up",
      type: "message",
      role: "assistant",
      model: "claude-up",
      content: [{ type: "text", text: "anth" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function geminiResponse(): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "gem" }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 3,
        totalTokenCount: 8,
      },
      modelVersion: "gemini-up",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const fetchImpl: FetchLike = async (input, init) => {
  const request =
    input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
  upstreamRequests.push(request.clone());
  const host = new URL(request.url).hostname;
  if (host === "anth.test") return anthroResponse();
  if (host === "gem.test") return geminiResponse();
  return new Response("{}", { status: 500 });
};

const app = createApp({ fetchImpl });

async function call(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function adminCall(path: string, method: string, body?: unknown): Promise<Response> {
  return call(path, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function setupProvider(
  name: string,
  type: string,
  protocol: string,
  baseUrl: string,
  apiKey: string,
  modelId: string,
  upstreamModelId: string,
): Promise<void> {
  const providerResponse = await adminCall("/admin/providers", "POST", {
    name,
    type,
    protocol,
    baseUrl,
    maxRetries: 0,
  });
  expect(providerResponse.status).toBe(201);
  const provider = (await providerResponse.json()) as { data: { id: string } };
  const account = await adminCall(`/admin/providers/${provider.data.id}/accounts`, "POST", {
    name: "primary",
    apiKey,
  });
  expect(account.status).toBe(201);
  const model = await adminCall("/admin/models", "POST", {
    providerId: provider.data.id,
    modelId,
    upstreamModelId,
    supportsStream: true,
  });
  expect(model.status).toBe(201);
}

beforeAll(async () => {
  const user = await createUser(env.DB, { displayName: "Cross Protocol User" });
  const pepper = env.API_KEY_PEPPER;
  if (!pepper) throw new Error("API_KEY_PEPPER is not configured for tests");
  const generated = await generateApiKey(pepper);
  downstreamKey = generated.plaintext;
  await createApiKeyRecord(env.DB, {
    userId: user.id,
    name: "cross-key",
    keyPrefix: generated.prefix,
    keyHash: generated.hash,
  });

  await setupProvider(
    "anth",
    "ANTHROPIC",
    "anthropic",
    "https://anth.test",
    "anth-upstream-key",
    "model-a",
    "claude-up",
  );
  await setupProvider(
    "gem",
    "GOOGLE_GEMINI",
    "gemini",
    "https://gem.test",
    "gem-upstream-key",
    "model-g",
    "gemini-up",
  );

  const publish = await adminCall("/admin/config/publish", "POST", { note: "cross-protocol" });
  expect([200, 201]).toContain(publish.status);
});

beforeEach(() => {
  upstreamRequests.length = 0;
});

describe("跨协议上游集成", () => {
  it("OpenAI Chat 客户端访问 Anthropic 上游", async () => {
    const response = await call("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "anth/model-a",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 64,
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    expect(body.choices[0]?.message.content).toBe("anth");
    expect(body.usage.prompt_tokens).toBe(4);
    expect(body.usage.completion_tokens).toBe(2);

    const upstream = upstreamRequests[0];
    expect(upstream?.url).toBe("https://anth.test/v1/messages");
    expect(upstream?.headers.get("x-api-key")).toBe("anth-upstream-key");
    expect(upstream?.headers.get("authorization")).toBeNull();
    const upstreamBody = (await upstream?.json()) as {
      max_tokens: number;
      messages: unknown[];
    };
    expect(upstreamBody.max_tokens).toBe(64);
    expect(upstreamBody.messages).toHaveLength(1);
  });

  it("Anthropic 客户端访问 Gemini 上游", async () => {
    const response = await call("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": downstreamKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gem/model-g",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      type: string;
      content: Array<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(body.type).toBe("message");
    expect(body.content[0]?.text).toBe("gem");
    expect(body.usage.input_tokens).toBe(5);
    expect(body.usage.output_tokens).toBe(3);

    const upstream = upstreamRequests[0];
    expect(upstream?.url).toBe(
      "https://gem.test/v1beta/models/gemini-up:generateContent",
    );
    expect(upstream?.headers.get("x-goog-api-key")).toBe("gem-upstream-key");
    const upstreamBody = (await upstream?.json()) as {
      contents: Array<{ role: string }>;
      generationConfig?: { maxOutputTokens?: number };
    };
    expect(upstreamBody.contents[0]?.role).toBe("user");
    expect(upstreamBody.generationConfig?.maxOutputTokens).toBe(64);
  });

  it("OpenAI Responses 客户端访问 Gemini 上游", async () => {
    const response = await call("/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gem/model-g", input: "hello" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      object: string;
      output: Array<{ type: string; content?: Array<{ text?: string }> }>;
      usage: { input_tokens: number };
    };
    expect(body.object).toBe("response");
    const message = body.output.find((item) => item.type === "message");
    expect(message?.content?.[0]?.text).toBe("gem");
    expect(body.usage.input_tokens).toBe(5);
  });
});

import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { generateApiKey } from "../../src/auth/api-key";
import { createApiKeyRecord, createUser } from "../../src/auth/repository";
import type { FetchLike } from "../../src/providers/types";

const ADMIN_TOKEN = "test-admin-token";
const UPSTREAM_KEY = "stream-upstream-key";

let downstreamKey = "";
let providerId = "";
let modelId = "";

const upstreamRequests: Request[] = [];
let upstreamHandler: (request: Request) => Promise<Response> = async () => new Response("{}");

const fetchImpl: FetchLike = async (input, init) => {
  const request =
    input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
  upstreamRequests.push(request.clone());
  return upstreamHandler(request);
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

function sseResponse(
  chunks: string[],
  options: { keepOpen?: boolean; cancelFlag?: { value: boolean }; errorAfter?: Error } = {},
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (options.errorAfter !== undefined) controller.error(options.errorAfter);
      else if (options.keepOpen !== true) controller.close();
    },
    cancel() {
      if (options.cancelFlag !== undefined) options.cancelFlag.value = true;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function openAIStreamChunks(text = "pong"): string[] {
  const first = text.slice(0, Math.ceil(text.length / 2));
  const second = text.slice(first.length);
  return [
    `data: {"id":"c1","object":"chat.completion.chunk","created":1700000000,"model":"gpt-stream-upstream","choices":[{"index":0,"delta":{"role":"assistant","content":"${first}"},"finish_reason":null}]}\n\n`,
    `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"${second}"},"finish_reason":null}]}\n\n`,
    'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
    "data: [DONE]\n\n",
  ];
}

beforeAll(async () => {
  const user = await createUser(env.DB, { displayName: "Streaming User" });
  const pepper = env.API_KEY_PEPPER;
  if (!pepper) throw new Error("API_KEY_PEPPER is not configured for tests");
  const generated = await generateApiKey(pepper);
  downstreamKey = generated.plaintext;
  await createApiKeyRecord(env.DB, {
    userId: user.id,
    name: "stream-key",
    keyPrefix: generated.prefix,
    keyHash: generated.hash,
  });

  const providerResponse = await adminCall("/admin/providers", "POST", {
    name: "streammock",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://stream.test/v1",
    maxRetries: 0,
  });
  expect(providerResponse.status).toBe(201);
  const provider = (await providerResponse.json()) as { data: { id: string } };
  providerId = provider.data.id;

  const accountResponse = await adminCall(`/admin/providers/${providerId}/accounts`, "POST", {
    name: "primary",
    apiKey: UPSTREAM_KEY,
  });
  expect(accountResponse.status).toBe(201);

  const modelResponse = await adminCall("/admin/models", "POST", {
    providerId,
    modelId: "gpt-stream",
    upstreamModelId: "gpt-stream-upstream",
    supportsStream: true,
  });
  expect(modelResponse.status).toBe(201);
  const model = (await modelResponse.json()) as { data: { id: string } };
  modelId = model.data.id;

  const publish = await adminCall("/admin/config/publish", "POST", { note: "streaming" });
  expect([200, 201]).toContain(publish.status);
});

beforeEach(() => {
  upstreamRequests.length = 0;
  upstreamHandler = async () => sseResponse(openAIStreamChunks());
});

describe("流式推理链路", () => {
  it("OpenAI 客户端流式请求逐块返回并包含最终 Usage", async () => {
    const response = await call("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-stream",
        messages: [{ role: "user", content: "ping" }],
        stream: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-fufu-stream")).toBe("1");
    expect(response.headers.get("x-fufu-provider")).toBe("streammock");

    const text = await response.text();
    expect(text).toContain('"content":"po"');
    expect(text).toContain('"content":"ng"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('"prompt_tokens":3');
    expect(text).toContain("data: [DONE]");

    const upstream = upstreamRequests[0];
    const upstreamBody = (await upstream?.json()) as {
      model: string;
      stream: boolean;
      stream_options?: { include_usage: boolean };
    };
    expect(upstreamBody.model).toBe("gpt-stream-upstream");
    expect(upstreamBody.stream).toBe(true);
    expect(upstreamBody.stream_options?.include_usage).toBe(true);
    expect(modelId).not.toBe("");
  });

  it("Anthropic 客户端接收跨协议流式事件", async () => {
    const response = await call("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": downstreamKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-stream",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain('"text":"po"');
    expect(text).toContain('"text":"ng"');
    expect(text).toContain('"stop_reason":"end_turn"');
    expect(text).toContain("event: message_stop");
    expect(text).toContain('"input_tokens":3');
    expect(text).toContain('"output_tokens":2');
  });

  it("客户端断开后取消上游流", async () => {
    const cancelFlag = { value: false };
    upstreamHandler = async () =>
      sseResponse(
        [
          'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"a"},"finish_reason":null}]}\n\n',
        ],
        { keepOpen: true, cancelFlag },
      );

    const response = await call("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-stream",
        messages: [{ role: "user", content: "ping" }],
        stream: true,
      }),
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    expect(first?.done).toBe(false);
    await reader?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cancelFlag.value).toBe(true);
  });

  it("上游在首内容前失败时返回普通协议错误而不是 SSE", async () => {
    upstreamHandler = async () =>
      new Response(JSON.stringify({ error: { message: "boom", type: "server_error" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });

    const response = await call("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-stream",
        messages: [{ role: "user", content: "ping" }],
        stream: true,
      }),
    });
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UPSTREAM_ERROR");
  });

  it("流式传输开始后的上游错误以错误事件结束且不切换上游", async () => {
    const encoder = new TextEncoder();
    let stage = 0;
    upstreamHandler = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (stage === 0) {
              stage = 1;
              controller.enqueue(
                encoder.encode(
                  'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}\n\n',
                ),
              );
              return;
            }
            controller.error(new Error("upstream broke"));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    const response = await call("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-stream",
        messages: [{ role: "user", content: "ping" }],
        stream: true,
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"content":"partial"');
    expect(text).toContain('"error"');
    expect(upstreamRequests).toHaveLength(1);
  });
});

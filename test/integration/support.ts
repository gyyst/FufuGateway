import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { createApp } from "../../src/app";
import type { FetchLike } from "../../src/providers/types";

export const ADMIN_TOKEN = "test-admin-token";

export type UpstreamHandler = (request: Request) => Response | Promise<Response>;

export interface Harness {
  readonly upstreamRequests: Request[];
  setUpstream(handler: UpstreamHandler): void;
  call(path: string, init?: RequestInit): Promise<Response>;
  admin(path: string, method: string, body?: unknown, token?: string): Promise<Response>;
  createProvider(input: Record<string, unknown> & { name: string; baseUrl: string }): Promise<Record<string, unknown> & { id: string }>;
  createAccount(
    providerId: string,
    input: Record<string, unknown> & { name?: string; apiKey?: string; secretRef?: string },
  ): Promise<Record<string, unknown> & { id: string }>;
  createModel(
    input: Record<string, unknown> & { providerId: string; modelId: string },
  ): Promise<Record<string, unknown> & { id: string }>;
  createUser(input?: Record<string, unknown>): Promise<Record<string, unknown> & { id: string }>;
  createApiKey(
    userId: string,
    input?: Record<string, unknown>,
  ): Promise<{ key: string; data: Record<string, unknown> & { id: string } }>;
  publish(note?: string): Promise<{ version: number; unchanged: boolean }>;
}

/** 创建经过真实 Hono 应用与本地 D1/KV/DO 的测试入口，仅替换出站 fetch。 */
export function createHarness(): Harness {
  let upstream: UpstreamHandler = () =>
    jsonResponse({ error: { message: "No upstream handler configured" } }, 500);
  const upstreamRequests: Request[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    const request =
      input instanceof Request
        ? input
        : new Request(typeof input === "string" ? input : input.toString(), init);
    upstreamRequests.push(request.clone());
    return upstream(request);
  };

  const app = createApp({ fetchImpl });

  async function call(path: string, init?: RequestInit): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  async function admin(
    path: string,
    method: string,
    body?: unknown,
    token = ADMIN_TOKEN,
  ): Promise<Response> {
    return call(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function jsonData<T>(response: Response, expectedStatus: number | number[]): Promise<T> {
    const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    const text = await response.text();
    if (!statuses.includes(response.status)) {
      throw new Error(`Expected HTTP ${statuses.join("/")} but got ${response.status}: ${text}`);
    }
    return JSON.parse(text) as T;
  }

  return {
    upstreamRequests,
    setUpstream(handler) {
      upstream = handler;
    },
    call,
    admin,
    async createProvider(input) {
      const response = await admin("/admin/providers", "POST", {
        type: "OPENAI_COMPATIBLE",
        protocol: "openai-chat",
        maxRetries: 0,
        ...input,
      });
      return (await jsonData<{ data: Record<string, unknown> & { id: string } }>(response, 201)).data;
    },
    async createAccount(providerId, input) {
      const response = await admin(`/admin/providers/${providerId}/accounts`, "POST", {
        name: "primary",
        ...input,
      });
      return (await jsonData<{ data: Record<string, unknown> & { id: string } }>(response, 201)).data;
    },
    async createModel(input) {
      const response = await admin("/admin/models", "POST", {
        supportsStream: true,
        ...input,
      });
      return (await jsonData<{ data: Record<string, unknown> & { id: string } }>(response, 201)).data;
    },
    async createUser(input = {}) {
      const response = await admin("/admin/users", "POST", {
        displayName: "Integration Test User",
        ...input,
      });
      return (await jsonData<{ data: Record<string, unknown> & { id: string } }>(response, 201)).data;
    },
    async createApiKey(userId, input = {}) {
      const response = await admin("/admin/api-keys", "POST", {
        userId,
        name: "integration-key",
        ...input,
      });
      const body = await jsonData<{ key: string; data: Record<string, unknown> & { id: string } }>(
        response,
        201,
      );
      if (typeof body.key !== "string" || !body.key.startsWith("fufu_sk_")) {
        throw new Error("API key response did not include a one-time plaintext key");
      }
      return body;
    },
    async publish(note = "integration test") {
      const response = await admin("/admin/config/publish", "POST", { note });
      return (await jsonData<{ data: { version: number; unchanged: boolean } }>(response, [200, 201]))
        .data;
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface SseOptions {
  keepOpen?: boolean;
  cancelFlag?: { value: boolean };
}

export function sseResponse(frames: readonly string[], options: SseOptions = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (options.keepOpen !== true) controller.close();
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

export interface WireUsage {
  input: number;
  output: number;
  cached?: number;
  reasoning?: number;
}

export function openAIChatCompletionResponse(text: string, usage: WireUsage): Response {
  return jsonResponse({
    id: "chatcmpl-upstream",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "upstream-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.input,
      completion_tokens: usage.output,
      total_tokens: usage.input + usage.output,
      ...(usage.cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: usage.cached } }),
    },
  });
}

export function openAIResponsesResponse(text: string, usage: WireUsage): Response {
  return jsonResponse({
    id: "resp_upstream",
    object: "response",
    created_at: 1_700_000_000,
    status: "completed",
    model: "upstream-model",
    output: [
      {
        type: "message",
        id: "msg_upstream",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    output_text: text,
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      total_tokens: usage.input + usage.output,
      ...(usage.cached === undefined ? {} : { input_tokens_details: { cached_tokens: usage.cached } }),
      ...(usage.reasoning === undefined
        ? {}
        : { output_tokens_details: { reasoning_tokens: usage.reasoning } }),
    },
    error: null,
    incomplete_details: null,
  });
}

export function anthropicMessageResponse(text: string, usage: WireUsage): Response {
  return jsonResponse({
    id: "msg_upstream",
    type: "message",
    role: "assistant",
    model: "upstream-model",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      ...(usage.cached === undefined ? {} : { cache_read_input_tokens: usage.cached }),
    },
  });
}

export function geminiContentResponse(text: string, usage: WireUsage): Response {
  return jsonResponse({
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: usage.input,
      candidatesTokenCount: usage.output,
      totalTokenCount: usage.input + usage.output,
      ...(usage.cached === undefined ? {} : { cachedContentTokenCount: usage.cached }),
      ...(usage.reasoning === undefined ? {} : { thoughtsTokenCount: usage.reasoning }),
    },
    modelVersion: "upstream-model",
  });
}

export function openAIChatStreamFrames(text: string, usage: WireUsage): string[] {
  const midpoint = Math.max(1, Math.ceil(text.length / 2));
  const first = text.slice(0, midpoint);
  const second = text.slice(midpoint);
  return [
    `data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1700000000,"model":"upstream-model","choices":[{"index":0,"delta":{"role":"assistant","content":"${first}"},"finish_reason":null}]}\n\n`,
    `data: {"id":"chatcmpl-stream","choices":[{"index":0,"delta":{"content":"${second}"},"finish_reason":null}]}\n\n`,
    'data: {"id":"chatcmpl-stream","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    `data: {"id":"chatcmpl-stream","choices":[],"usage":{"prompt_tokens":${usage.input},"completion_tokens":${usage.output},"total_tokens":${usage.input + usage.output}}}\n\n`,
    "data: [DONE]\n\n",
  ];
}

export function openAIResponsesStreamFrames(text: string, usage: WireUsage): string[] {
  const midpoint = Math.max(1, Math.ceil(text.length / 2));
  const first = text.slice(0, midpoint);
  const second = text.slice(midpoint);
  const event = (name: string, payload: Record<string, unknown>): string =>
    `event: ${name}\ndata: ${JSON.stringify({ type: name, ...payload })}\n\n`;
  return [
    event("response.created", {
      response: {
        id: "resp_stream",
        object: "response",
        created_at: 1_700_000_000,
        status: "in_progress",
        model: "upstream-model",
        output: [],
      },
    }),
    event("response.output_item.added", {
      output_index: 0,
      item: {
        id: "msg_stream",
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    }),
    event("response.content_part.added", {
      item_id: "msg_stream",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
    event("response.output_text.delta", {
      item_id: "msg_stream",
      output_index: 0,
      content_index: 0,
      delta: first,
    }),
    event("response.output_text.delta", {
      item_id: "msg_stream",
      output_index: 0,
      content_index: 0,
      delta: second,
    }),
    event("response.output_item.done", {
      output_index: 0,
      item: {
        id: "msg_stream",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    }),
    event("response.completed", {
      response: {
        id: "resp_stream",
        object: "response",
        created_at: 1_700_000_000,
        status: "completed",
        model: "upstream-model",
        output: [],
        usage: {
          input_tokens: usage.input,
          output_tokens: usage.output,
          total_tokens: usage.input + usage.output,
        },
      },
    }),
  ];
}

export function geminiStreamFrames(text: string, usage: WireUsage): string[] {
  const midpoint = Math.max(1, Math.ceil(text.length / 2));
  const first = text.slice(0, midpoint);
  const second = text.slice(midpoint);
  return [
    `data: ${JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: first }] }, index: 0 }],
      modelVersion: "upstream-model",
      responseId: "gemini_stream",
    })}\n\n`,
    `data: ${JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text: second }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: usage.input,
        candidatesTokenCount: usage.output,
        totalTokenCount: usage.input + usage.output,
      },
      modelVersion: "upstream-model",
      responseId: "gemini_stream",
    })}\n\n`,
  ];
}

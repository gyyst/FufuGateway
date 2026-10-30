import { describe, expect, it } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createApp } from "../../src/app";
import type { FetchLike } from "../../src/providers/types";

const fetchImpl: FetchLike = async () =>
  new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

describe("请求体限制", () => {
  it("超过 maxBodyBytes 时返回 413", async () => {
    const app = createApp({ fetchImpl, maxBodyBytes: 64 });
    const ctx = createExecutionContext();
    const response = await app.fetch(
      new Request("https://gateway.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "y".repeat(200) }] }),
        // 显式 content-length 用于测试预检。
        headers: { "content-type": "application/json", "content-length": "300" },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_LIMIT_EXCEEDED");
  });
});

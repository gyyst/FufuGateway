import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

interface HealthBody {
  status: string;
  service: string;
  version: string;
  requestId: string;
}

describe("健康检查", () => {
  it("GET /health 返回 ok 并附带请求标识", async () => {
    const response = await exports.default.fetch("https://gateway.test/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("x-trace-id")).toBeTruthy();

    const body = (await response.json()) as HealthBody;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("FufuGateway");
    expect(body.requestId).toBe(response.headers.get("x-request-id"));
  });

  it("GET /health/ready 检查 D1、KV 与 Durable Object", async () => {
    const response = await exports.default.fetch("https://gateway.test/health/ready");
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      checks: Record<string, { ok: boolean }>;
    };
    expect(body.status).toBe("ready");
    expect(body.checks["d1"]?.ok).toBe(true);
    expect(body.checks["kv"]?.ok).toBe(true);
    expect(body.checks["coordination"]?.ok).toBe(true);
  });

  it("GET / 返回服务信息", async () => {
    const response = await exports.default.fetch("https://gateway.test/");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { service: string };
    expect(body.service).toBe("FufuGateway");
  });

  it("未知路由返回统一错误格式", async () => {
    const response = await exports.default.fetch("https://gateway.test/not-exists");
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { code: string; message: string; request_id: string };
    };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.request_id).toBe(response.headers.get("x-request-id"));
  });

  it("保留客户端提供的合法 request id", async () => {
    const response = await exports.default.fetch("https://gateway.test/health", {
      headers: { "x-request-id": "client-request-0001" },
    });
    expect(response.headers.get("x-request-id")).toBe("client-request-0001");
  });

  it("忽略非法的客户端 request id", async () => {
    const response = await exports.default.fetch("https://gateway.test/health", {
      headers: { "x-request-id": "bad id with spaces" },
    });
    expect(response.headers.get("x-request-id")).not.toBe("bad id with spaces");
    expect(response.headers.get("x-request-id")).toMatch(/^req_/);
  });
});

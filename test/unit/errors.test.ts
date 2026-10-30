import { describe, expect, it } from "vitest";
import { GatewayError, isGatewayError, toGatewayError } from "../../src/core/errors";

describe("GatewayError", () => {
  it("使用错误码对应的默认 HTTP 状态", () => {
    const error = new GatewayError({ code: "MODEL_NOT_FOUND", message: "no model" });
    expect(error.status).toBe(404);
    expect(error.retriable).toBe(false);
  });

  it("允许覆盖状态码", () => {
    const error = new GatewayError({
      code: "REQUEST_LIMIT_EXCEEDED",
      message: "too large",
      status: 413,
    });
    expect(error.status).toBe(413);
  });

  it("未知异常收敛为 INTERNAL_ERROR 且不暴露原始信息", () => {
    const original = new Error("database password is hunter2");
    const error = toGatewayError(original);
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.publicMessage).toBe("Internal gateway error");
    expect(error.cause).toBe(original);
  });

  it("AbortError 转为 REQUEST_CANCELLED", () => {
    const abort = new DOMException("The operation was aborted", "AbortError");
    const error = toGatewayError(abort);
    expect(error.code).toBe("REQUEST_CANCELLED");
    expect(error.status).toBe(499);
  });

  it("保留已有 GatewayError 实例", () => {
    const original = new GatewayError({ code: "INVALID_REQUEST", message: "bad" });
    expect(toGatewayError(original)).toBe(original);
    expect(isGatewayError(original)).toBe(true);
  });

  it("withDetails 返回新实例并合并 details", () => {
    const original = new GatewayError({
      code: "UNSUPPORTED_FEATURE",
      message: "unsupported",
      details: { feature: "thinking" },
    });
    const next = original.withDetails({ target: "openai-chat" });
    expect(next.details).toEqual({ feature: "thinking", target: "openai-chat" });
    expect(original.details).toEqual({ feature: "thinking" });
  });
});

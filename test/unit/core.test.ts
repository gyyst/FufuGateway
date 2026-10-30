import { describe, expect, it } from "vitest";
import { parseTraceparent, sanitizeRequestId, timingSafeEqual, ulid } from "../../src/core/ids";
import { redact, redactText } from "../../src/core/redact";
import { isRecord, parseJsonObject, truncate } from "../../src/core/json";

describe("ids", () => {
  it("生成唯一且长度固定的 ULID", () => {
    const ids = new Set(Array.from({ length: 200 }, () => ulid()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toHaveLength(26);
  });

  it("解析 W3C traceparent", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    expect(parseTraceparent(`00-${traceId}-00f067aa0ba902b7-01`)).toBe(traceId);
    expect(parseTraceparent(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`)).toBeUndefined();
    expect(parseTraceparent("garbage")).toBeUndefined();
    expect(parseTraceparent(null)).toBeUndefined();
  });

  it("只接受格式安全的 request id", () => {
    expect(sanitizeRequestId("req_abc-123.456")).toBe("req_abc-123.456");
    expect(sanitizeRequestId("has space")).toBeUndefined();
    expect(sanitizeRequestId("short")).toBeUndefined();
    expect(sanitizeRequestId("x".repeat(200))).toBeUndefined();
  });

  it("常量时间比较结果正确", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
  });
});

describe("redact", () => {
  it("按字段名脱敏敏感信息", () => {
    const result = redact({
      authorization: "Bearer secret-token",
      apiKey: "sk-1234567890abcdef",
      input_tokens: 12,
      nested: { client_secret: "value", ok: true },
    }) as Record<string, unknown>;
    expect(result["authorization"]).toBe("[redacted]");
    expect(result["apiKey"]).toBe("[redacted]");
    expect(result["input_tokens"]).toBe(12);
    expect((result["nested"] as Record<string, unknown>)["ok"]).toBe(true);
  });

  it("脱敏字符串中的密钥模式", () => {
    expect(redactText("Authorization: Bearer abc.def.ghi")).toContain("Bearer ***");
    expect(redactText("key fufu_sk_abcdef123456")).toBe("key fufu_sk_***");
    expect(redactText("openai sk-abcdefghijklmnop")).toContain("sk-***");
  });
});

describe("json", () => {
  it("识别普通对象", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  it("解析对象并拒绝数组", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject("[1,2]")).toBeUndefined();
  });

  it("截断长字符串", () => {
    expect(truncate("abcdef", 5)).toBe("ab...");
    expect(truncate("abc", 5)).toBe("abc");
  });
});

import { describe, expect, it } from "vitest";
import { GatewayError } from "../../src/core/errors";
import { compareGlobSpecificity, compileGlob, globMatches } from "../../src/router/glob";
import { sanitizeCustomHeaders, validateUpstreamBaseUrl } from "../../src/security/ssrf";

function expectInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return;
  }
  throw new Error("expected GatewayError");
}

describe("SSRF 防护", () => {
  it("只接受 HTTPS 公网地址", () => {
    expect(validateUpstreamBaseUrl("https://api.example.com/v1", { allowPrivate: false }).hostname).toBe(
      "api.example.com",
    );
  });

  it("拒绝 http、私有地址、环回、链路本地与元数据地址", () => {
    for (const url of [
      "http://api.example.com/v1",
      "https://localhost/v1",
      "https://127.0.0.1/v1",
      "https://10.0.0.1/v1",
      "https://172.16.0.1/v1",
      "https://192.168.1.1/v1",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/v1",
      "https://metadata.google.internal/v1",
      "https://service.internal/v1",
      "https://user:pass@api.example.com/v1",
      "https://api.example.com:8443/v1",
      "https://api.example.com/v1#fragment",
    ]) {
      expectInvalid(() => validateUpstreamBaseUrl(url, { allowPrivate: false }));
    }
  });

  it("本地开发模式允许私有地址与 http", () => {
    expect(
      validateUpstreamBaseUrl("http://localhost:8080/v1", { allowPrivate: true }).port,
    ).toBe("8080");
  });

  it("拒绝受保护与非法自定义请求头", () => {
    expect(sanitizeCustomHeaders({ "x-custom": "ok" })).toEqual({ "x-custom": "ok" });
    for (const headers of [
      { authorization: "Bearer x" },
      { "x-api-key": "x" },
      { "x-goog-api-key": "x" },
      { cookie: "x" },
      { connection: "keep-alive" },
      { "x-forwarded-for": "1.1.1.1" },
      { "x-bad\nheader": "x" },
      { "x-custom": "line1\r\nline2" },
    ]) {
      expectInvalid(() => sanitizeCustomHeaders(headers));
    }
  });
});

describe("Glob 匹配", () => {
  it("支持 * 与 ?，其余字符按字面量匹配", () => {
    const star = compileGlob("claude-*");
    expect(globMatches(star, "claude-sonnet-4-5")).toBe(true);
    expect(globMatches(star, "gpt-5")).toBe(false);

    const question = compileGlob("gpt-?");
    expect(globMatches(question, "gpt-5")).toBe(true);
    expect(globMatches(question, "gpt-50")).toBe(false);

    const literalDots = compileGlob("gemini-2.5-*");
    expect(globMatches(literalDots, "gemini-2.5-pro")).toBe(true);
    expect(globMatches(literalDots, "gemini-2x5-pro")).toBe(false);
  });

  it("拒绝正则元字符、无通配符与超长 pattern", () => {
    expectInvalid(() => compileGlob("claude-[0-9]+"));
    expectInvalid(() => compileGlob("claude-sonnet"));
    expectInvalid(() => compileGlob("a".repeat(201) + "*"));
  });

  it("具体度排序：字面量多、通配符少、段数多者优先", () => {
    const general = compileGlob("claude-*");
    const specific = compileGlob("claude-sonnet-*");
    const moreSegments = compileGlob("claude-*-sonnet");
    expect(compareGlobSpecificity(specific, general)).toBeLessThan(0);
    expect(compareGlobSpecificity(general, specific)).toBeGreaterThan(0);
    expect(compareGlobSpecificity(moreSegments, general)).toBeLessThan(0);
  });

  it("通配符不会因为正则回溯导致异常（只编译安全子集）", () => {
    const compiled = compileGlob("*a*a*a*a*a*a*a*a");
    expect(globMatches(compiled, `${"a".repeat(5000)}`)).toBe(true);
  });
});

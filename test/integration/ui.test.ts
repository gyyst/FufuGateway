import { describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";

describe("管理界面", () => {
  it("GET /ui 返回单页应用外壳与安全头", async () => {
    const response = await exports.default.fetch("https://gateway.test/ui");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    const html = await response.text();
    expect(html).toContain("FufuGateway");
    expect(html).toContain("/ui-static/app.js");
    expect(html).toContain("/ui-static/app.css");
    expect(html).toContain('id="login-form"');
    expect(html).toContain('id="app"');
  });

  it("GET /ui/ 同样可用", async () => {
    const response = await exports.default.fetch("https://gateway.test/ui/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("FufuGateway 管理台");
  });
});

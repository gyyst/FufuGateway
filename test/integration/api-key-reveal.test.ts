import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createHarness } from "./support";

const harness = createHarness();

interface RevealBody {
  data: { id: string; name: string; keyPrefix: string; key: string };
}

describe("下游 API Key 明文查看", () => {
  it("创建后可通过 reveal 取得相同明文，列表不泄露明文或哈希", async () => {
    const user = await harness.createUser({ displayName: "Reveal User" });
    const created = await harness.createApiKey(user.id, { name: "reveal-key" });

    const list = await harness.admin(`/admin/api-keys?userId=${user.id}`, "GET");
    const listText = await list.text();
    expect(listText).not.toContain(created.key);
    expect(listText).not.toContain("keyHash");
    expect(listText).not.toContain("key_hash");
    expect(listText).not.toContain("keyPlain");
    expect(listText).not.toContain("key_plain");

    const reveal = await harness.admin(`/admin/api-keys/${created.data.id}/reveal`, "GET");
    expect(reveal.status).toBe(200);
    const body = (await reveal.json()) as RevealBody;
    expect(body.data.key).toBe(created.key);
    expect(body.data.keyPrefix).toBe(created.data.keyPrefix);
    expect(body.data.name).toBe("reveal-key");
  });

  it("轮换生成的新 Key 可查看明文", async () => {
    const user = await harness.createUser({ displayName: "Rotate User" });
    const created = await harness.createApiKey(user.id, { name: "rotate-key" });

    const rotated = await harness.admin(`/admin/api-keys/${created.data.id}/rotate`, "POST", {});
    expect(rotated.status).toBe(201);
    const rotatedBody = (await rotated.json()) as {
      data: { id: string };
      key: string;
    };
    expect(rotatedBody.key).not.toBe(created.key);

    const reveal = await harness.admin(`/admin/api-keys/${rotatedBody.data.id}/reveal`, "GET");
    expect(reveal.status).toBe(200);
    expect(((await reveal.json()) as RevealBody).data.key).toBe(rotatedBody.key);
  });

  it("旧 Key 没有明文时返回可理解的错误", async () => {
    const user = await harness.createUser({ displayName: "Legacy User" });
    const created = await harness.createApiKey(user.id, { name: "legacy-key" });
    await env.DB.prepare("UPDATE api_keys SET key_plain = NULL WHERE id = ?")
      .bind(created.data.id)
      .run();

    const reveal = await harness.admin(`/admin/api-keys/${created.data.id}/reveal`, "GET");
    expect(reveal.status).toBe(404);
    const body = (await reveal.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message.toLowerCase()).toContain("rotate");
  });

  it("reveal 写入审计且审计日志不包含明文", async () => {
    const user = await harness.createUser({ displayName: "Audit User" });
    const created = await harness.createApiKey(user.id, { name: "audit-reveal-key" });

    expect((await harness.admin(`/admin/api-keys/${created.data.id}/reveal`, "GET")).status).toBe(
      200,
    );

    const logs = await harness.admin("/admin/audit-logs?limit=200", "GET");
    const text = await logs.text();
    expect(text).not.toContain(created.key);
    const body = JSON.parse(text) as {
      data: Array<{ action: string; targetId: string | null; details: Record<string, unknown> | null }>;
    };
    const entry = body.data.find(
      (item) => item.action === "api_key.reveal" && item.targetId === created.data.id,
    );
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry?.details)).not.toContain(created.key);
  });
});

import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { FetchLike } from "../../src/providers/types";

const ADMIN_TOKEN = "test-admin-token";
const UPSTREAM_KEY = "plain-upstream-secret";

let providerId = "";
let downstreamKey = "";
const upstreamRequests: Request[] = [];

const fetchImpl: FetchLike = async (input, init) => {
  const request =
    input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
  upstreamRequests.push(request.clone());
  return new Response(
    JSON.stringify({
      id: "chatcmpl-plain",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "plain-upstream",
      choices: [{ index: 0, message: { role: "assistant", content: "plain-ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
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

interface AccountResponse {
  data: {
    id: string;
    name: string;
    apiKey?: string;
    secretRef?: string;
    hasKey: boolean;
    credentialType: string;
  };
}

interface AccountRow {
  api_key_plain: string | null;
  api_key_enc: string | null;
  api_key_iv: string | null;
  api_key_tag: string | null;
  secret_ref: string | null;
}

async function accountRow(id: string): Promise<AccountRow> {
  const row = await env.DB.prepare(
    "SELECT api_key_plain, api_key_enc, api_key_iv, api_key_tag, secret_ref FROM provider_accounts WHERE id = ?",
  )
    .bind(id)
    .first<AccountRow>();
  if (row === null) throw new Error(`Account ${id} not found`);
  return row;
}

beforeAll(async () => {
  const provider = await adminCall("/admin/providers", "POST", {
    name: "plainacct",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://plain.test/v1",
    maxRetries: 0,
  });
  expect(provider.status).toBe(201);
  providerId = ((await provider.json()) as { data: { id: string } }).data.id;

  const account = await adminCall(`/admin/providers/${providerId}/accounts`, "POST", {
    name: "primary",
    apiKey: UPSTREAM_KEY,
  });
  expect(account.status).toBe(201);

  const model = await adminCall("/admin/models", "POST", {
    providerId,
    modelId: "plain-chat",
    upstreamModelId: "plain-upstream",
    supportsStream: true,
  });
  expect(model.status).toBe(201);

  const userResponse = await adminCall("/admin/users", "POST", { displayName: "Plain User" });
  expect(userResponse.status).toBe(201);
  const user = (await userResponse.json()) as { data: { id: string } };
  const keyResponse = await adminCall("/admin/api-keys", "POST", {
    userId: user.data.id,
    name: "plain-key",
    scopes: ["inference"],
  });
  expect(keyResponse.status).toBe(201);
  downstreamKey = ((await keyResponse.json()) as { key: string }).key;

  const publish = await adminCall("/admin/config/publish", "POST", { note: "plaintext-accounts" });
  expect([200, 201]).toContain(publish.status);
});

describe("上游账户凭据存储", () => {
  it("apiKey 以明文落库，管理响应不返回明文", async () => {
    const detail = await adminCall(`/admin/providers/${providerId}`, "GET");
    expect(detail.status).toBe(200);
    const text = await detail.text();
    expect(text).not.toContain(UPSTREAM_KEY);
    const body = JSON.parse(text) as { data: { accounts: AccountResponse["data"][] } };
    const primary = body.data.accounts.find((account) => account.name === "primary");
    expect(primary?.credentialType).toBe("api_key");
    expect(primary?.hasKey).toBe(true);
    expect(primary?.apiKey).toBeUndefined();

    const row = await accountRow(primary!.id);
    expect(row.api_key_plain).toBe(UPSTREAM_KEY);
    expect(row.api_key_enc).toBeNull();
    expect(row.api_key_iv).toBeNull();
    expect(row.api_key_tag).toBeNull();

    const list = await adminCall(`/admin/providers/${providerId}/accounts`, "GET");
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText).not.toContain(UPSTREAM_KEY);
    const listBody = JSON.parse(listText) as { data: AccountResponse["data"][] };
    expect(listBody.data.every((account) => account.apiKey === undefined)).toBe(true);
    expect(listBody.data.find((account) => account.name === "primary")?.credentialType).toBe("api_key");
  });

  it("secretRef 账户不写明文列", async () => {
    const created = await adminCall(`/admin/providers/${providerId}/accounts`, "POST", {
      name: "secret-primary",
      secretRef: "PLAIN_UPSTREAM_KEY",
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as AccountResponse;
    expect(body.data.credentialType).toBe("secret_ref");
    expect(body.data.hasKey).toBe(true);
    expect(body.data.apiKey).toBeUndefined();

    const row = await accountRow(body.data.id);
    expect(row.api_key_plain).toBeNull();
    expect(row.secret_ref).toBe("PLAIN_UPSTREAM_KEY");
  });

  it("更新凭据时 apiKey 与 secretRef 互相清除", async () => {
    const created = await adminCall(`/admin/providers/${providerId}/accounts`, "POST", {
      name: "switchable",
      apiKey: "switch-key-one",
    });
    expect(created.status).toBe(201);
    const accountId = ((await created.json()) as AccountResponse).data.id;

    const toSecret = await adminCall(`/admin/providers/${providerId}/accounts/${accountId}`, "PUT", {
      secretRef: "SWITCHABLE_KEY",
    });
    expect(toSecret.status).toBe(200);
    expect(((await toSecret.json()) as AccountResponse).data.credentialType).toBe("secret_ref");
    let row = await accountRow(accountId);
    expect(row.api_key_plain).toBeNull();
    expect(row.secret_ref).toBe("SWITCHABLE_KEY");

    const toPlain = await adminCall(`/admin/providers/${providerId}/accounts/${accountId}`, "PUT", {
      apiKey: "switch-key-two",
    });
    expect(toPlain.status).toBe(200);
    expect(((await toPlain.json()) as AccountResponse).data.credentialType).toBe("api_key");
    row = await accountRow(accountId);
    expect(row.api_key_plain).toBe("switch-key-two");
    expect(row.secret_ref).toBeNull();
  });

  it("创建账户同时提供 apiKey 与 secretRef 返回 400", async () => {
    const response = await adminCall(`/admin/providers/${providerId}/accounts`, "POST", {
      name: "conflicting-create",
      apiKey: "conflicting-key",
      secretRef: "CONFLICTING_KEY",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("更新时同时提供 apiKey 与 secretRef 返回 400", async () => {
    const created = await adminCall(`/admin/providers/${providerId}/accounts`, "POST", {
      name: "conflicting",
      apiKey: "conflicting-key",
    });
    expect(created.status).toBe(201);
    const accountId = ((await created.json()) as AccountResponse).data.id;

    const response = await adminCall(`/admin/providers/${providerId}/accounts/${accountId}`, "PUT", {
      apiKey: "conflicting-new-key",
      secretRef: "CONFLICTING_KEY",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("setup 状态只报告 adminToken", async () => {
    const response = await adminCall("/admin/setup/status", "GET");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { secrets: Record<string, boolean>; steps: Array<{ id: string; detail: string }> };
    };
    expect(body.data.secrets).toEqual({ adminToken: true });
    expect(body.data.steps.find((step) => step.id === "secrets")?.detail).toBe("管理员令牌已配置。");
  });

  it("推理直接使用明文 apiKey 调用上游", async () => {
    upstreamRequests.length = 0;
    const response = await call("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "plainacct/plain-chat",
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(upstreamRequests[0]?.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_KEY}`);
  });
});

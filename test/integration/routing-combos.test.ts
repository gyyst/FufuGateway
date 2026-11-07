import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, openAIChatCompletionResponse } from "./support";

const harness = createHarness();
let key = "";

beforeAll(async () => {
  const user = await harness.createUser({ displayName: "Routing Combo User" });
  key = (await harness.createApiKey(user.id, { name: "routing-key" })).key;

  const provider = await harness.createProvider({
    name: "rc-a",
    baseUrl: "https://rc-a.test/v1",
  });
  await harness.createAccount(provider.id, { apiKey: "rc-a-upstream-key" });
  await harness.createModel({
    providerId: provider.id,
    modelId: "rc-cheap",
    upstreamModelId: "rc-cheap-up",
    inputPrice: 1,
    outputPrice: 1,
  });
  await harness.createModel({
    providerId: provider.id,
    modelId: "rc-expensive",
    upstreamModelId: "rc-expensive-up",
    inputPrice: 100,
    outputPrice: 100,
  });

  async function createCombo(name: string, body: Record<string, unknown>): Promise<void> {
    const response = await harness.admin("/admin/combos", "POST", { name, ...body });
    expect(response.status).toBe(201);
  }

  await createCombo("rc-priority", {
    strategy: "priority",
    nodes: [
      { model: "rc-a/rc-cheap", priority: 10 },
      { model: "rc-a/rc-expensive", priority: 100 },
    ],
  });
  await createCombo("rc-weighted", {
    strategy: "weighted_round_robin",
    nodes: [
      { model: "rc-a/rc-cheap", weight: 3 },
      { model: "rc-a/rc-expensive", weight: 1 },
    ],
  });
  await createCombo("rc-cost", {
    strategy: "lowest_cost",
    nodes: ["rc-a/rc-expensive", "rc-a/rc-cheap"],
  });
  await createCombo("rc-glob-*", {
    strategy: "fallback",
    priority: 100,
    nodes: ["rc-a/rc-cheap"],
  });
  await createCombo("rc-glob-model-*", {
    strategy: "fallback",
    priority: 100,
    nodes: ["rc-a/rc-expensive"],
  });
  await createCombo("rc-glob-model-x", {
    strategy: "fallback",
    priority: 999,
    nodes: ["rc-a/rc-cheap"],
  });
  await createCombo("rc-prio-*", {
    strategy: "fallback",
    priority: 500,
    nodes: ["rc-a/rc-cheap"],
  });
  await createCombo("rc-prio-model-*", {
    strategy: "fallback",
    priority: 100,
    nodes: ["rc-a/rc-expensive"],
  });
  await createCombo("rc-disabled", {
    strategy: "fallback",
    enabled: false,
    nodes: ["rc-a/rc-cheap"],
  });
  await createCombo("rc-preview", {
    strategy: "fallback",
    nodes: ["rc-a/rc-cheap", { combo: "rc-cost" }],
  });

  await harness.publish("routing combos");
});

beforeEach(() => {
  harness.upstreamRequests.length = 0;
  harness.setUpstream(async (request) => {
    const body = (await request.json()) as { model: string };
    const content = body.model.includes("expensive") ? "expensive" : "cheap";
    return openAIChatCompletionResponse(content, { input: 1, output: 1 });
  });
});

function chat(model: string): Promise<Response> {
  return harness.call("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }] }),
  });
}

async function contentOf(response: Response): Promise<string> {
  const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  return body.choices[0]?.message.content ?? "";
}

async function upstreamModels(): Promise<string[]> {
  return Promise.all(
    harness.upstreamRequests.map(async (request) => {
      const body = (await request.json()) as { model: string };
      return body.model;
    }),
  );
}

describe("Combo 策略", () => {
  it("priority 策略优先选择高优先级节点", async () => {
    const response = await chat("rc-priority");
    expect(response.status).toBe(200);
    expect(await contentOf(response)).toBe("expensive");
    expect(await upstreamModels()).toEqual(["rc-expensive-up"]);
  });

  it("weighted_round_robin 按权重分配请求", async () => {
    const contents: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      contents.push(await contentOf(await chat("rc-weighted")));
    }

    expect(contents.filter((content) => content === "cheap")).toHaveLength(3);
    expect(contents.filter((content) => content === "expensive")).toHaveLength(1);
    const models = await upstreamModels();
    expect(models.filter((model) => model === "rc-cheap-up")).toHaveLength(3);
    expect(models.filter((model) => model === "rc-expensive-up")).toHaveLength(1);
  });

  it("lowest_cost 策略选择价格更低的节点", async () => {
    const contents: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      contents.push(await contentOf(await chat("rc-cost")));
    }
    expect(contents).toEqual(["cheap", "cheap", "cheap"]);
    expect(await upstreamModels()).toEqual(["rc-cheap-up", "rc-cheap-up", "rc-cheap-up"]);
  });
});

describe("glob Combo 路由", () => {
  it("精确 Combo 名称优先于 glob Combo", async () => {
    expect(await contentOf(await chat("rc-glob-model-x"))).toBe("cheap");
  });

  it("多个 glob 命中时更具体的模式优先", async () => {
    expect(await contentOf(await chat("rc-glob-model-y"))).toBe("expensive");
    expect(await contentOf(await chat("rc-glob-other"))).toBe("cheap");
  });

  it("glob 优先级高于具体度", async () => {
    expect(await contentOf(await chat("rc-prio-model-z"))).toBe("cheap");
  });

  it("禁用的 Combo 不参与路由", async () => {
    const response = await chat("rc-disabled");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MODEL_NOT_FOUND");
    expect(harness.upstreamRequests).toHaveLength(0);
  });
});

describe("Combo 管理与诊断", () => {
  it("Combo 创建、更新、发布与删除后路由同步变化", async () => {
    const created = await harness.admin("/admin/combos", "POST", {
      name: "rc-crud",
      strategy: "fallback",
      nodes: ["rc-a/rc-cheap"],
    });
    expect(created.status).toBe(201);
    const combo = ((await created.json()) as { data: { id: string } }).data;
    await harness.publish("routing crud create");

    expect(await contentOf(await chat("rc-crud"))).toBe("cheap");

    const updated = await harness.admin(`/admin/combos/${combo.id}`, "PUT", {
      nodes: ["rc-a/rc-expensive"],
    });
    expect(updated.status).toBe(200);
    await harness.publish("routing crud update");
    expect(await contentOf(await chat("rc-crud"))).toBe("expensive");

    expect((await harness.admin(`/admin/combos/${combo.id}`, "DELETE")).status).toBe(200);
    await harness.publish("routing crud delete");
    expect((await chat("rc-crud")).status).toBe(404);
  });

  it("validate 报告 fusion 缺少 judgeModel", async () => {
    const created = await harness.admin("/admin/combos", "POST", {
      name: "rc-fusion-invalid",
      strategy: "fusion",
      nodes: ["rc-a/rc-cheap"],
    });
    expect(created.status).toBe(201);
    const combo = ((await created.json()) as { data: { id: string } }).data;

    const validation = await harness.admin(`/admin/combos/${combo.id}/validate`, "POST", {});
    expect(validation.status).toBe(200);
    const body = (await validation.json()) as {
      valid: boolean;
      issues: Array<{ severity: string; code: string; message: string }>;
    };
    expect(body.valid).toBe(false);
    expect(body.issues.some((issue) => issue.message.includes("judgeModel"))).toBe(true);

    await harness.admin(`/admin/combos/${combo.id}`, "DELETE");
  });

  it("preview 展示模型节点与嵌套 Combo 的解析结果", async () => {
    const combos = (await (
      await harness.admin("/admin/combos", "GET")
    ).json()) as { data: Array<{ id: string; name: string }> };
    const previewCombo = combos.data.find((combo) => combo.name === "rc-preview");
    expect(previewCombo).toBeDefined();

    const response = await harness.admin(
      `/admin/combos/${previewCombo?.id}/preview`,
      "POST",
      {},
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        nodes: Array<{
          index: number;
          plan?: {
            kind: string;
            targets?: Array<{ provider: string; model: string; upstreamModel: string }>;
            combo?: string;
            strategy?: string;
          };
          error?: { code: string };
        }>;
      };
    };
    expect(body.data.nodes).toHaveLength(2);
    expect(body.data.nodes[0]?.plan?.kind).toBe("models");
    expect(body.data.nodes[0]?.plan?.targets?.[0]).toEqual({
      provider: "rc-a",
      model: "rc-cheap",
      upstreamModel: "rc-cheap-up",
    });
    expect(body.data.nodes[1]?.plan?.kind).toBe("combo");
    expect(body.data.nodes[1]?.plan?.combo).toBe("rc-cost");
    expect(body.data.nodes[1]?.plan?.strategy).toBe("lowest_cost");
  });
});

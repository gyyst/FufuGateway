import type { Context } from "hono";
import type { AppEnv } from "../../app";
import { GatewayError, isGatewayError } from "../../core/errors";
import type { ComboRecord } from "../../combo/types";
import { normalizeComboNodeTarget } from "../../combo/validator";
import type { RoutePlan } from "../../combo/types";
import {
  createCombo,
  deleteCombo,
  getCombo,
  listCombos,
  loadConfigData,
  replaceCombo,
} from "../../config/repository";
import { buildRuntimeConfig } from "../../config/runtime";
import type { ConfigValidationIssue } from "../../config/types";
import { validateSnapshot } from "../../config/validate";
import { compileGlob } from "../../router/glob";
import { ModelRouter } from "../../router/resolver";
import { isPrivateUpstreamAllowed } from "../../security/ssrf";
import { comboCreateSchema, comboUpdateSchema } from "../schemas";
import {
  assertVirtualNameAvailable,
  configMutationResponse,
  parseAdminBody,
  requireParam,
  validateComboNodeInput,
  validateVirtualName,
} from "../shared";

export async function listCombosHandler(c: Context<AppEnv>): Promise<Response> {
  return c.json({ data: await listCombos(c.env.DB) });
}

export async function getComboHandler(c: Context<AppEnv>): Promise<Response> {
  const combo = await getCombo(c.env.DB, requireParam(c, "id"));
  if (combo === undefined) throw new GatewayError({ code: "NOT_FOUND", message: "Combo not found" });
  return c.json({ data: combo });
}

export async function createComboHandler(c: Context<AppEnv>): Promise<Response> {
  const input = await parseAdminBody(c, comboCreateSchema);
  validateVirtualName(input.name, "combo");
  input.nodes.forEach(validateComboNodeInput);
  await assertVirtualNameAvailable(c, input.name, {});
  const combo = await createCombo(c.env.DB, {
    name: input.name,
    strategy: input.strategy,
    nodes: input.nodes,
    judgeModel: input.judgeModel,
    description: input.description,
    timeoutMs: input.timeoutMs,
    maxConcurrency: input.maxConcurrency,
    sticky: input.sticky,
    priority: input.priority,
    enabled: input.enabled,
  });
  return configMutationResponse(
    c,
    "combo.create",
    "combo",
    combo.id,
    { name: combo.name },
    { data: combo },
    201,
  );
}

export async function updateComboHandler(c: Context<AppEnv>): Promise<Response> {
  const combo = await getCombo(c.env.DB, requireParam(c, "id"));
  if (combo === undefined) throw new GatewayError({ code: "NOT_FOUND", message: "Combo not found" });
  const input = await parseAdminBody(c, comboUpdateSchema);
  const name = input.name ?? combo.name;
  validateVirtualName(name, "combo");
  if (input.nodes !== undefined) input.nodes.forEach(validateComboNodeInput);
  if (name !== combo.name) {
    await assertVirtualNameAvailable(c, name, { comboId: combo.id });
  }
  const updated: ComboRecord = {
    ...combo,
    name,
    ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
    ...(input.nodes === undefined ? {} : { nodes: input.nodes }),
    ...(input.judgeModel === undefined ? {} : { judgeModel: input.judgeModel }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
    ...(input.sticky === undefined ? {} : { sticky: input.sticky }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    updatedAt: Date.now(),
  };
  await replaceCombo(c.env.DB, updated);
  return configMutationResponse(
    c,
    "combo.update",
    "combo",
    combo.id,
    { name: updated.name },
    { data: updated },
  );
}

export async function deleteComboHandler(c: Context<AppEnv>): Promise<Response> {
  const combo = await getCombo(c.env.DB, requireParam(c, "id"));
  if (combo === undefined) throw new GatewayError({ code: "NOT_FOUND", message: "Combo not found" });
  await deleteCombo(c.env.DB, combo.id);
  return configMutationResponse(
    c,
    "combo.delete",
    "combo",
    combo.id,
    { name: combo.name },
    { deleted: true, id: combo.id },
  );
}

export async function validateComboHandler(c: Context<AppEnv>): Promise<Response> {
  const combo = await getCombo(c.env.DB, requireParam(c, "id"));
  if (combo === undefined) throw new GatewayError({ code: "NOT_FOUND", message: "Combo not found" });
  const data = await loadConfigData(c.env.DB);
  const issues = validateSnapshot(data, {
    allowPrivateUpstreams: isPrivateUpstreamAllowed(c.env),
  }).filter(
    (issue) =>
      issue.code === "COMBO_CYCLE_DETECTED" ||
      (issue.entityType === "combo" && issue.entityId === combo.id),
  );
  return c.json({
    valid: !issues.some((issue) => issue.severity === "error"),
    comboId: combo.id,
    issues,
  });
}

function summarizePlan(plan: RoutePlan): Record<string, unknown> {
  if (plan.kind === "models") {
    return {
      kind: "models",
      strategy: plan.strategy,
      targets: plan.targets.map((target) => ({
        provider: target.providerName,
        model: target.modelId,
        upstreamModel: target.upstreamModelId,
      })),
    };
  }
  if (plan.kind === "combo") {
    return { kind: "combo", combo: plan.combo.name, strategy: plan.combo.strategy };
  }
  return {
    kind: "inline_combo",
    strategy: plan.strategy,
    nodes: plan.nodes.map((node) =>
      node.kind === "model"
        ? { kind: "model", provider: node.modelTarget?.providerName, model: node.modelTarget?.modelId }
        : { kind: "combo", combo: node.comboName },
    ),
  };
}

async function buildPreviewRouter(c: Context<AppEnv>): Promise<ModelRouter> {
  const data = await loadConfigData(c.env.DB);
  const validCombos = data.combos.filter((combo) => {
    if (!combo.name.includes("*") && !combo.name.includes("?")) return true;
    try {
      compileGlob(combo.name);
      return true;
    } catch {
      return false;
    }
  });
  const validWildcards = (data.wildcards ?? []).filter((rule) => {
    try {
      compileGlob(rule.pattern);
      return true;
    } catch {
      return false;
    }
  });
  return new ModelRouter(
    buildRuntimeConfig(
      { ...data, combos: validCombos, wildcards: validWildcards },
      { version: 0, checksum: "", createdAt: 0, source: "d1-fallback" },
    ),
  );
}

export async function previewComboHandler(c: Context<AppEnv>): Promise<Response> {
  const combo = await getCombo(c.env.DB, requireParam(c, "id"));
  if (combo === undefined) throw new GatewayError({ code: "NOT_FOUND", message: "Combo not found" });
  const router = await buildPreviewRouter(c);

  const nodes = combo.nodes.map((spec, index) => {
    const target = normalizeComboNodeTarget(spec);
    if (target === undefined) {
      return { index, error: { code: "CONFIG_INVALID", message: "Node must specify exactly one target type" } };
    }
    try {
      return { index, target, plan: summarizePlan(router.resolveTargetSpec(target)) };
    } catch (error) {
      return {
        index,
        target,
        error: {
          code: isGatewayError(error) ? error.code : "CONFIG_INVALID",
          message: error instanceof Error ? error.message : "Failed to resolve node",
        },
      };
    }
  });

  const issues: ConfigValidationIssue[] = [];
  if (!combo.enabled) {
    issues.push({
      severity: "warning",
      code: "COMBO_DISABLED",
      message: `Combo "${combo.name}" is disabled and will not be routed`,
      entityType: "combo",
      entityId: combo.id,
    });
  }

  return c.json({
    data: {
      comboId: combo.id,
      name: combo.name,
      strategy: combo.strategy,
      judgeModel: combo.judgeModel ?? null,
      enabled: combo.enabled,
      nodes,
      issues,
    },
  });
}

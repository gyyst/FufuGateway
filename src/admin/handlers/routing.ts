import type { Context } from "hono";
import type { AppEnv } from "../../app";
import { GatewayError } from "../../core/errors";
import type { AliasRecord, WildcardRuleRecord } from "../../config/types";
import {
  createAlias,
  createWildcard,
  deleteAlias,
  deleteWildcard,
  getAlias,
  getWildcard,
  listAliases,
  listCombos,
  listModels,
  listWildcards,
  replaceAlias,
  replaceWildcard,
} from "../../config/repository";
import { compileGlob, compareGlobSpecificity, globMatches } from "../../router/glob";
import {
  aliasCreateSchema,
  aliasUpdateSchema,
  wildcardCreateSchema,
  wildcardPreviewSchema,
  wildcardUpdateSchema,
} from "../schemas";
import {
  assertVirtualNameAvailable,
  parseAdminBody,
  recordAudit,
  requireParam,
  validateRouteTargetInput,
  validateVirtualName,
} from "../shared";

// ---------------------------------------------------------------------------
// Alias
// ---------------------------------------------------------------------------

export async function listAliasesHandler(c: Context<AppEnv>): Promise<Response> {
  return c.json({ data: await listAliases(c.env.DB) });
}

export async function getAliasHandler(c: Context<AppEnv>): Promise<Response> {
  const alias = await getAlias(c.env.DB, requireParam(c, "id"));
  if (alias === undefined) throw new GatewayError({ code: "NOT_FOUND", message: "Alias not found" });
  return c.json({ data: alias });
}

export async function createAliasHandler(c: Context<AppEnv>): Promise<Response> {
  const input = await parseAdminBody(c, aliasCreateSchema);
  validateVirtualName(input.name, "alias");
  validateRouteTargetInput(input.target);
  await assertVirtualNameAvailable(c, input.name, {});
  const alias = await createAlias(c.env.DB, {
    name: input.name,
    target: input.target,
    description: input.description,
    enabled: input.enabled,
    priority: input.priority,
  });
  await recordAudit(c, "alias.create", "alias", alias.id, { name: alias.name });
  return c.json({ data: alias }, 201);
}

export async function updateAliasHandler(c: Context<AppEnv>): Promise<Response> {
  const alias = await getAlias(c.env.DB, requireParam(c, "id"));
  if (alias === undefined) throw new GatewayError({ code: "NOT_FOUND", message: "Alias not found" });
  const input = await parseAdminBody(c, aliasUpdateSchema);
  const name = input.name ?? alias.name;
  validateVirtualName(name, "alias");
  const target = input.target === undefined ? alias.target : validateRouteTargetInput(input.target);
  if (name !== alias.name) {
    await assertVirtualNameAvailable(c, name, { aliasId: alias.id });
  }
  const updated: AliasRecord = {
    ...alias,
    name,
    target,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    updatedAt: Date.now(),
  };
  await replaceAlias(c.env.DB, updated);
  await recordAudit(c, "alias.update", "alias", alias.id, { name: updated.name });
  return c.json({ data: updated });
}

export async function deleteAliasHandler(c: Context<AppEnv>): Promise<Response> {
  const alias = await getAlias(c.env.DB, requireParam(c, "id"));
  if (alias === undefined) throw new GatewayError({ code: "NOT_FOUND", message: "Alias not found" });
  await deleteAlias(c.env.DB, alias.id);
  await recordAudit(c, "alias.delete", "alias", alias.id, { name: alias.name });
  return c.json({ deleted: true, id: alias.id });
}

// ---------------------------------------------------------------------------
// Wildcard
// ---------------------------------------------------------------------------

export async function listWildcardsHandler(c: Context<AppEnv>): Promise<Response> {
  return c.json({ data: await listWildcards(c.env.DB) });
}

export async function getWildcardHandler(c: Context<AppEnv>): Promise<Response> {
  const rule = await getWildcard(c.env.DB, requireParam(c, "id"));
  if (rule === undefined) throw new GatewayError({ code: "NOT_FOUND", message: "Wildcard rule not found" });
  return c.json({ data: rule });
}

export async function createWildcardHandler(c: Context<AppEnv>): Promise<Response> {
  const input = await parseAdminBody(c, wildcardCreateSchema);
  compileGlob(input.pattern);
  const targets = input.targets.map((target) => validateRouteTargetInput(target));
  const rule = await createWildcard(c.env.DB, {
    pattern: input.pattern,
    strategy: input.strategy,
    targets,
    priority: input.priority,
    enabled: input.enabled,
    description: input.description,
  });
  await recordAudit(c, "wildcard.create", "wildcard", rule.id, { pattern: rule.pattern });
  return c.json({ data: rule }, 201);
}

export async function updateWildcardHandler(c: Context<AppEnv>): Promise<Response> {
  const rule = await getWildcard(c.env.DB, requireParam(c, "id"));
  if (rule === undefined) throw new GatewayError({ code: "NOT_FOUND", message: "Wildcard rule not found" });
  const input = await parseAdminBody(c, wildcardUpdateSchema);
  const pattern = input.pattern ?? rule.pattern;
  compileGlob(pattern);
  const targets =
    input.targets === undefined ? rule.targets : input.targets.map((target) => validateRouteTargetInput(target));
  const updated: WildcardRuleRecord = {
    ...rule,
    pattern,
    targets,
    ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.description === undefined ? {} : { description: input.description }),
    updatedAt: Date.now(),
  };
  await replaceWildcard(c.env.DB, updated);
  await recordAudit(c, "wildcard.update", "wildcard", rule.id, { pattern: updated.pattern });
  return c.json({ data: updated });
}

export async function deleteWildcardHandler(c: Context<AppEnv>): Promise<Response> {
  const rule = await getWildcard(c.env.DB, requireParam(c, "id"));
  if (rule === undefined) throw new GatewayError({ code: "NOT_FOUND", message: "Wildcard rule not found" });
  await deleteWildcard(c.env.DB, rule.id);
  await recordAudit(c, "wildcard.delete", "wildcard", rule.id, { pattern: rule.pattern });
  return c.json({ deleted: true, id: rule.id });
}

export async function previewWildcardHandler(c: Context<AppEnv>): Promise<Response> {
  const input = await parseAdminBody(c, wildcardPreviewSchema);
  const compiled = compileGlob(input.pattern);

  let candidates = input.models;
  if (candidates === undefined) {
    const [models, aliases, combos] = await Promise.all([
      listModels(c.env.DB),
      listAliases(c.env.DB),
      listCombos(c.env.DB),
    ]);
    candidates = [
      ...new Set([
        ...models.filter((model) => model.enabled).map((model) => model.modelId),
        ...aliases.filter((alias) => alias.enabled).map((alias) => alias.name),
        ...combos.filter((combo) => combo.enabled).map((combo) => combo.name),
      ]),
    ];
  }

  const matches = candidates.filter((modelId) => globMatches(compiled, modelId)).sort();
  const specificity = { literalChars: compiled.literalChars, wildcards: compiled.wildcards, segments: compiled.segments };

  // 展示该规则在优先级排序中的位置。
  const existing = await listWildcards(c.env.DB);
  const others = existing
    .filter((rule) => rule.pattern !== input.pattern)
    .map((rule) => {
      try {
        return { rule, compiled: compileGlob(rule.pattern) };
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is { rule: WildcardRuleRecord; compiled: ReturnType<typeof compileGlob> } => entry !== undefined);

  const winsAgainst = others
    .filter((entry) => compareGlobSpecificity(compiled, entry.compiled) < 0)
    .map((entry) => entry.rule.pattern);

  return c.json({ data: { pattern: input.pattern, matches, specificity, moreSpecificThan: winsAgainst } });
}

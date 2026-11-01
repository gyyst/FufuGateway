import type { Context } from "hono";
import type { AppEnv } from "../../app";
import { GatewayError } from "../../core/errors";
import type { AliasRecord } from "../../config/types";
import {
  createAlias,
  deleteAlias,
  getAlias,
  listAliases,
  replaceAlias,
} from "../../config/repository";
import { aliasCreateSchema, aliasUpdateSchema } from "../schemas";
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

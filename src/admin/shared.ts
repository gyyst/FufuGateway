import type { Context } from "hono";
import type { ZodType } from "zod";
import type { AppEnv } from "../app";
import { GatewayError } from "../core/errors";
import { DEFAULT_MAX_BODY_BYTES } from "../core/limits";
import { redact } from "../core/redact";
import type { ProviderAccountRecord, ProviderRecord, ProviderType } from "../config/types";
import type { ComboNodeSpec, RouteTargetSpec } from "../combo/types";
import { normalizeComboNodeTarget } from "../combo/validator";
import { isProtocolId, PROTOCOL_IDS } from "../ir/common";
import { isPrivateUpstreamAllowed, sanitizeCustomHeaders, validateUpstreamBaseUrl } from "../security/ssrf";
import { compileGlob } from "../router/glob";
import { readJsonObjectBody } from "../gateway/body";
import {
  listAliases,
  listCombos,
  listModels,
  listProviders,
} from "../config/repository";

/** 校验虚拟模型名称在别名 / Combo / 原生模型 / Provider 命名空间中的唯一性。 */
export async function assertVirtualNameAvailable(
  c: Context<AppEnv>,
  name: string,
  exclude: { aliasId?: string; comboId?: string },
): Promise<void> {
  const lower = name.toLowerCase();
  const [aliases, combos, models, providers] = await Promise.all([
    listAliases(c.env.DB),
    listCombos(c.env.DB),
    listModels(c.env.DB),
    listProviders(c.env.DB),
  ]);
  if (aliases.some((alias) => alias.name.toLowerCase() === lower && alias.id !== exclude.aliasId)) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: `Name "${name}" is already used by an alias` });
  }
  if (combos.some((combo) => combo.name.toLowerCase() === lower && combo.id !== exclude.comboId)) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: `Name "${name}" is already used by a combo` });
  }
  if (models.some((model) => model.modelId.toLowerCase() === lower)) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: `Name "${name}" conflicts with a native model ID` });
  }
  if (providers.some((provider) => provider.name.toLowerCase() === lower)) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: `Name "${name}" conflicts with a provider name` });
  }
}

export async function parseAdminBody<T>(c: Context<AppEnv>, schema: ZodType<T>): Promise<T> {
  const body = await readJsonObjectBody(c, DEFAULT_MAX_BODY_BYTES);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new GatewayError({
      code: "INVALID_REQUEST",
      message: "Invalid request body",
      details: {
        issues: parsed.error.issues.slice(0, 10).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  }
  return parsed.data;
}

const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9._:/@+-]{1,200}$/;
const VIRTUAL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;

const ALLOWED_PROTOCOLS: Record<ProviderType, readonly string[]> = {
  OPENAI_COMPATIBLE: ["openai-chat", "openai-responses"],
  ANTHROPIC: ["anthropic"],
  GOOGLE_GEMINI: ["gemini"],
  CUSTOM: PROTOCOL_IDS,
};

export function validateProviderName(name: string): void {
  if (!PROVIDER_NAME.test(name)) {
    throw new GatewayError({
      code: "INVALID_REQUEST",
      message: "Provider name must be 1-64 characters and contain only letters, digits, dots, underscores or hyphens",
    });
  }
}

export function validateModelId(modelId: string): void {
  if (!MODEL_ID.test(modelId)) {
    throw new GatewayError({
      code: "INVALID_REQUEST",
      message: "Model ID contains unsupported characters or is too long",
    });
  }
  if (modelId.includes("://") || modelId.includes("..")) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "Model ID is not allowed" });
  }
}

export function validateVirtualName(name: string, kind: "alias" | "combo"): void {
  if (kind === "combo" && (name.includes("*") || name.includes("?"))) {
    try {
      compileGlob(name);
    } catch (error) {
      throw new GatewayError({
        code: "INVALID_REQUEST",
        message: error instanceof Error ? error.message : "Invalid combo glob pattern",
      });
    }
    return;
  }
  if (!VIRTUAL_NAME.test(name)) {
    throw new GatewayError({
      code: "INVALID_REQUEST",
      message: `${kind} name must not contain slashes and must be 1-128 valid characters`,
    });
  }
}

export function assertProviderTypeProtocol(type: ProviderType, protocol: string): void {
  if (!isProtocolId(protocol)) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: `Unknown protocol "${protocol}"` });
  }
  if (!ALLOWED_PROTOCOLS[type].includes(protocol)) {
    throw new GatewayError({
      code: "INVALID_REQUEST",
      message: `Provider type ${type} cannot use protocol ${protocol}`,
    });
  }
}

export function validateProviderUrlAndHeaders(
  c: Context<AppEnv>,
  baseUrl: string,
  customHeaders: Record<string, string> | undefined,
): Record<string, string> {
  validateUpstreamBaseUrl(baseUrl, { allowPrivate: isPrivateUpstreamAllowed(c.env) });
  return sanitizeCustomHeaders(customHeaders ?? {});
}

export function validateRouteTargetInput(target: RouteTargetSpec): RouteTargetSpec {
  if (typeof target === "string") {
    if (target.trim() === "") {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "Route target must not be empty" });
    }
    return target;
  }
  const keys = Object.keys(target);
  if (keys.length !== 1) {
    throw new GatewayError({
      code: "INVALID_REQUEST",
      message: "Route target must specify exactly one of model/alias/combo/wildcard",
    });
  }
  return target;
}

export function validateComboNodeInput(spec: ComboNodeSpec): void {
  if (normalizeComboNodeTarget(spec) === undefined) {
    throw new GatewayError({
      code: "INVALID_REQUEST",
      message: "Combo node must specify exactly one of model/alias/wildcard/combo",
    });
  }
}

export function sanitizeProvider(provider: ProviderRecord): Omit<ProviderRecord, never> {
  return provider;
}

export function sanitizeAccount(account: ProviderAccountRecord): Record<string, unknown> {
  const { encryptedKey, ...rest } = account;
  return {
    ...rest,
    hasKey: encryptedKey !== undefined || account.secretRef !== undefined,
    credentialType: encryptedKey !== undefined ? "encrypted" : account.secretRef !== undefined ? "secret_ref" : "none",
  };
}

export async function recordAudit(
  c: Context<AppEnv>,
  action: string,
  targetType: string,
  targetId: string | null,
  details?: Record<string, unknown>,
): Promise<void> {
  const principal = c.get("principal");
  if (principal === undefined) return;
  const actorType = principal.type;
  const actorId = principal.apiKey?.id ?? principal.user?.id ?? "admin";
  await c.env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      `aud_${crypto.randomUUID()}`,
      actorType,
      actorId,
      action,
      targetType,
      targetId,
      details === undefined ? null : JSON.stringify(redact(details)),
      Date.now(),
    )
    .run();
}

export function requireProviderId(c: Context<AppEnv>): string {
  const id = c.req.param("id");
  if (!id) throw new GatewayError({ code: "INVALID_REQUEST", message: "Provider id is required" });
  return id;
}

export function requireParam(c: Context<AppEnv>, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new GatewayError({ code: "INVALID_REQUEST", message: `${name} is required` });
  return value;
}

import { z } from "zod";

export const providerTypeSchema = z.enum([
  "OPENAI_COMPATIBLE",
  "ANTHROPIC",
  "GOOGLE_GEMINI",
  "CUSTOM",
]);

export const protocolSchema = z.enum(["openai-chat", "openai-responses", "anthropic", "gemini"]);

export const strategySchema = z.enum([
  "fallback",
  "round_robin",
  "weighted_round_robin",
  "random",
  "priority",
  "lowest_latency",
  "lowest_cost",
  "race",
  "fusion",
]);

export const modalitySchema = z.enum(["text", "image", "audio", "video", "file"]);
export const outputModalitySchema = z.enum(["text", "image", "audio", "embedding"]);

const retrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10),
  baseDelayMs: z.number().int().min(0).max(60_000),
  maxDelayMs: z.number().int().min(0).max(300_000),
  jitter: z.enum(["full", "none"]),
  retryStatuses: z.array(z.number().int().min(100).max(599)).max(20),
  retryOnNetworkError: z.boolean(),
  retryOnTimeout: z.enum(["never", "before_first_byte", "always"]),
  respectRetryAfter: z.boolean(),
});

export const providerCreateSchema = z.object({
  name: z.string().min(1).max(64),
  type: providerTypeSchema,
  protocol: protocolSchema,
  baseUrl: z.string().min(1).max(2048),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  weight: z.number().int().min(1).max(10_000).optional(),
  customHeaders: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
  firstTokenTimeoutMs: z.number().int().min(100).max(600_000).optional(),
  idleTimeoutMs: z.number().int().min(100).max(600_000).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  retry: retrySchema.nullable().optional(),
  proxyConfig: z.record(z.string(), z.unknown()).nullable().optional(),
  extraConfig: z.record(z.string(), z.unknown()).optional(),
});

export const providerUpdateSchema = providerCreateSchema.partial();

export const accountCreateSchema = z
  .object({
    name: z.string().min(1).max(64),
    apiKey: z.string().min(1).max(4096).optional(),
    secretRef: z.string().min(1).max(64).optional(),
    weight: z.number().int().min(1).max(10_000).optional(),
    priority: z.number().int().min(0).max(1_000_000).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => (value.apiKey === undefined) !== (value.secretRef === undefined), {
    message: "Provide exactly one of apiKey or secretRef",
    path: ["apiKey"],
  });

export const accountUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  apiKey: z.string().min(1).max(4096).optional(),
  secretRef: z.string().min(1).max(64).optional(),
  weight: z.number().int().min(1).max(10_000).optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  enabled: z.boolean().optional(),
});

const capabilitiesSchema = z.object({
  inputModalities: z.array(modalitySchema).min(1).optional(),
  outputModalities: z.array(outputModalitySchema).min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  supportsStream: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsParallelTools: z.boolean().optional(),
  supportsJsonSchema: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsAudio: z.boolean().optional(),
  supportsVideo: z.boolean().optional(),
  supportsPromptCache: z.boolean().optional(),
});

export const modelCreateSchema = capabilitiesSchema.extend({
  providerId: z.string().min(1).max(128),
  modelId: z.string().min(1).max(200),
  upstreamModelId: z.string().min(1).max(200).optional(),
  displayName: z.string().max(200).optional(),
  inputPrice: z.number().min(0).max(1_000_000).optional(),
  outputPrice: z.number().min(0).max(1_000_000).optional(),
  cachedInputPrice: z.number().min(0).max(1_000_000).optional(),
  reasoningPrice: z.number().min(0).max(1_000_000).optional(),
  enabled: z.boolean().optional(),
});

export const modelUpdateSchema = capabilitiesSchema.extend({
  modelId: z.string().min(1).max(200).optional(),
  upstreamModelId: z.string().min(1).max(200).optional(),
  displayName: z.string().max(200).optional(),
  inputPrice: z.number().min(0).max(1_000_000).optional(),
  outputPrice: z.number().min(0).max(1_000_000).optional(),
  cachedInputPrice: z.number().min(0).max(1_000_000).optional(),
  reasoningPrice: z.number().min(0).max(1_000_000).optional(),
  enabled: z.boolean().optional(),
});

export const routeTargetSchema = z.union([
  z.string().min(1).max(200),
  z.object({ model: z.string().min(1).max(200) }),
  z.object({ alias: z.string().min(1).max(128) }),
  z.object({ combo: z.string().min(1).max(128) }),
  z.object({ wildcard: z.string().min(1).max(200) }),
]);

export const aliasCreateSchema = z.object({
  name: z.string().min(1).max(128),
  target: routeTargetSchema,
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
});

export const aliasUpdateSchema = aliasCreateSchema.partial();

export const wildcardCreateSchema = z.object({
  pattern: z.string().min(1).max(200),
  strategy: strategySchema,
  targets: z.array(routeTargetSchema).min(1).max(64),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  enabled: z.boolean().optional(),
  description: z.string().max(500).optional(),
});

export const wildcardUpdateSchema = wildcardCreateSchema.partial();

export const wildcardPreviewSchema = z.object({
  pattern: z.string().min(1).max(200),
  models: z.array(z.string().min(1).max(200)).max(10_000).optional(),
});

const comboNodeSchema = z.union([
  z.string().min(1).max(200),
  z.object({
    model: z.string().min(1).max(200).optional(),
    alias: z.string().min(1).max(128).optional(),
    wildcard: z.string().min(1).max(200).optional(),
    combo: z.string().min(1).max(128).optional(),
    weight: z.number().positive().max(1_000_000).optional(),
    priority: z.number().int().min(0).max(1_000_000).optional(),
    timeoutMs: z.number().int().min(100).max(600_000).optional(),
    maxRetries: z.number().int().min(0).max(10).optional(),
    strategy: strategySchema.optional(),
  }),
]);

const stickySchema = z.object({
  enabled: z.boolean(),
  ttlSeconds: z.number().int().min(1).max(604_800),
  mode: z.enum(["round_robin", "first_available"]),
  hashFirstUserMessage: z.boolean().optional(),
});

export const comboCreateSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(500).optional(),
  strategy: strategySchema,
  nodes: z.array(comboNodeSchema).min(1).max(256),
  judgeModel: z.string().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
  maxConcurrency: z.number().int().min(1).max(32).optional(),
  sticky: stickySchema.optional(),
  enabled: z.boolean().optional(),
});

export const comboUpdateSchema = comboCreateSchema.partial();

export const configPublishSchema = z.object({
  note: z.string().max(500).optional(),
});

export const configRollbackSchema = z.object({
  version: z.number().int().positive(),
});

export const pricingCreateSchema = z.object({
  providerId: z.string().min(1).max(128),
  modelId: z.string().min(1).max(200),
  inputPrice: z.number().min(0).max(1_000_000),
  outputPrice: z.number().min(0).max(1_000_000),
  cachedInputPrice: z.number().min(0).max(1_000_000).optional(),
  reasoningPrice: z.number().min(0).max(1_000_000).optional(),
  currency: z.string().min(1).max(8).optional(),
  effectiveFrom: z.number().int().positive().optional(),
});

const emailSchema = z
  .string()
  .max(254)
  .refine((value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value), { message: "Invalid email" });

export const userCreateSchema = z.object({
  tenantId: z.string().min(1).max(64).optional(),
  email: emailSchema.optional(),
  displayName: z.string().max(100).optional(),
  role: z.enum(["admin", "user"]).optional(),
  rpmLimit: z.number().int().positive().max(1_000_000).nullable().optional(),
  tpmLimit: z.number().int().positive().max(1_000_000_000).nullable().optional(),
  concurrencyLimit: z.number().int().positive().max(10_000).nullable().optional(),
  dailyBudgetUsd: z.number().min(0).max(1_000_000).nullable().optional(),
  monthlyBudgetUsd: z.number().min(0).max(10_000_000).nullable().optional(),
});

export const userUpdateSchema = z.object({
  tenantId: z.string().min(1).max(64).optional(),
  email: emailSchema.nullable().optional(),
  displayName: z.string().max(100).nullable().optional(),
  role: z.enum(["admin", "user"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  rpmLimit: z.number().int().positive().max(1_000_000).nullable().optional(),
  tpmLimit: z.number().int().positive().max(1_000_000_000).nullable().optional(),
  concurrencyLimit: z.number().int().positive().max(10_000).nullable().optional(),
  dailyBudgetUsd: z.number().min(0).max(1_000_000).nullable().optional(),
  monthlyBudgetUsd: z.number().min(0).max(10_000_000).nullable().optional(),
});

const scopeSchema = z.array(z.string().min(1).max(32)).max(20);

export const apiKeyCreateSchema = z.object({
  userId: z.string().min(1).max(128),
  name: z.string().min(1).max(64),
  scopes: scopeSchema.optional(),
  modelAllowlist: z.array(z.string().min(1).max(200)).max(500).optional(),
  providerAllowlist: z.array(z.string().min(1).max(128)).max(100).optional(),
  rpmLimit: z.number().int().positive().max(1_000_000).nullable().optional(),
  tpmLimit: z.number().int().positive().max(1_000_000_000).nullable().optional(),
  concurrencyLimit: z.number().int().positive().max(10_000).nullable().optional(),
  dailyBudgetUsd: z.number().min(0).max(1_000_000).nullable().optional(),
  monthlyBudgetUsd: z.number().min(0).max(10_000_000).nullable().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
});

export const apiKeyUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  scopes: scopeSchema.optional(),
  modelAllowlist: z.array(z.string().min(1).max(200)).max(500).nullable().optional(),
  providerAllowlist: z.array(z.string().min(1).max(128)).max(100).nullable().optional(),
  rpmLimit: z.number().int().positive().max(1_000_000).nullable().optional(),
  tpmLimit: z.number().int().positive().max(1_000_000_000).nullable().optional(),
  concurrencyLimit: z.number().int().positive().max(10_000).nullable().optional(),
  dailyBudgetUsd: z.number().min(0).max(1_000_000).nullable().optional(),
  monthlyBudgetUsd: z.number().min(0).max(10_000_000).nullable().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  status: z.enum(["active", "disabled", "revoked"]).optional(),
});

export const apiKeyRotateSchema = z.object({
  revokeOld: z.boolean().optional(),
});

import type { Context } from "hono";
import type { AppEnv } from "../../app";
import type { ConfigValidationIssue } from "../../config/types";
import { getConfigStatus } from "../../config/snapshot";
import { listProviderPresets } from "../../providers/presets";
import { GatewayError } from "../../core/errors";

interface CountRow {
  n: number;
}

interface AuditRow {
  action: string;
  details: string | null;
  created_at: number;
}

type SetupStepId =
  | "secrets"
  | "provider"
  | "account"
  | "model"
  | "publish"
  | "api_key"
  | "gateway_test";

interface SetupStep {
  id: SetupStepId;
  label: string;
  complete: boolean;
  detail: string;
  action?: { page: string; query?: string };
}

function secretConfigured(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

async function count(db: D1Database, sql: string): Promise<number> {
  const row = await db.prepare(sql).first<CountRow>();
  return Number(row?.n ?? 0);
}

function parseAuditDetails(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function listProviderPresetsHandler(c: Context<AppEnv>): Promise<Response> {
  return c.json({ data: listProviderPresets() });
}

export async function setupStatusHandler(c: Context<AppEnv>): Promise<Response> {
  const [
    providers,
    providersWithAccounts,
    providersWithModels,
    models,
    enabledModels,
    activeApiKeys,
  ] = await Promise.all([
    count(c.env.DB, "SELECT COUNT(*) AS n FROM providers"),
    count(
      c.env.DB,
      "SELECT COUNT(DISTINCT provider_id) AS n FROM provider_accounts WHERE enabled = 1",
    ),
    count(c.env.DB, "SELECT COUNT(DISTINCT provider_id) AS n FROM models"),
    count(c.env.DB, "SELECT COUNT(*) AS n FROM models"),
    count(c.env.DB, "SELECT COUNT(*) AS n FROM models WHERE enabled = 1"),
    count(c.env.DB, "SELECT COUNT(*) AS n FROM api_keys WHERE status = 'active'"),
  ]);

  let config;
  try {
    config = await getConfigStatus(c.env);
  } catch (error) {
    const message = error instanceof GatewayError ? error.publicMessage : "Failed to load configuration";
    config = {
      activeVersion: null,
      activeChecksum: null,
      activeCreatedAt: null,
      pendingChecksum: null,
      pendingChanges: true,
      validation: {
        valid: false,
        issues: [
          {
            severity: "error" as const,
            code: error instanceof GatewayError ? error.code : "CONFIG_INVALID",
            message,
          },
        ],
      },
    };
  }

  const secrets = {
    adminToken: secretConfigured(c.env.ADMIN_TOKEN),
  };
  const secretsComplete = secrets.adminToken;

  const audit = await c.env.DB.prepare(
    `SELECT action, details, created_at FROM audit_logs
     WHERE action IN ('gateway.test.success', 'gateway.test.failure')
     ORDER BY created_at DESC LIMIT 1`,
  ).first<AuditRow>();
  const auditDetails = audit === null ? null : parseAuditDetails(audit.details);
  const lastGatewayTest =
    audit === null
      ? null
      : {
          success: audit.action === "gateway.test.success",
          at: audit.created_at,
          errorCode:
            typeof auditDetails?.["errorCode"] === "string" ? auditDetails["errorCode"] : null,
        };

  const issues: ConfigValidationIssue[] = config.validation?.issues ?? [];
  const configValid = config.validation?.valid === true;
  const configPublished =
    config.activeVersion !== null && !config.pendingChanges && configValid;

  const missingSecrets = [!secrets.adminToken ? "ADMIN_TOKEN" : null].filter(
    (value): value is string => value !== null,
  );

  const steps: SetupStep[] = [
    {
      id: "secrets",
      label: "配置 Worker Secrets",
      complete: secretsComplete,
      detail: secretsComplete
        ? "管理员令牌已配置。"
        : `缺少：${missingSecrets.join("、")}`,
    },
    {
      id: "provider",
      label: "添加 Provider",
      complete: providers > 0,
      detail: providers > 0 ? `已有 ${providers} 个 Provider。` : "至少添加一个上游 Provider。",
      action: { page: "providers" },
    },
    {
      id: "account",
      label: "添加上游账户",
      complete: providersWithAccounts > 0,
      detail:
        providersWithAccounts > 0
          ? `${providersWithAccounts} 个 Provider 有启用的账户。`
          : "Provider 需要至少一个启用账户，优先使用 Worker Secret 引用。",
      action: { page: "providers" },
    },
    {
      id: "model",
      label: "创建并启用模型",
      complete: enabledModels > 0,
      detail:
        enabledModels > 0
          ? `已有 ${enabledModels} 个启用模型（共 ${models} 个）。`
          : models > 0
            ? `${models} 个模型已同步/创建，但尚未启用。`
            : "同步上游模型或手动添加模型，并确认能力后启用。",
      action: { page: "providers" },
    },
    {
      id: "publish",
      label: "发布配置版本",
      complete: configPublished,
      detail: configPublished
        ? `当前配置版本 v${config.activeVersion} 已生效。`
        : config.activeVersion === null
          ? "配置尚未发布，推理入口会回退到 D1 草稿。"
          : config.pendingChanges
            ? "D1 中有未发布变更。"
            : "配置校验未通过。",
      action: { page: "config" },
    },
    {
      id: "api_key",
      label: "创建下游 API Key",
      complete: activeApiKeys > 0,
      detail:
        activeApiKeys > 0
          ? `已有 ${activeApiKeys} 个活跃 API Key。`
          : "创建用户和 API Key，客户端才能调用网关。",
      action: { page: "keys" },
    },
    {
      id: "gateway_test",
      label: "运行网关自测",
      complete: lastGatewayTest?.success === true,
      detail:
        lastGatewayTest === null
          ? "尚未运行自测。自测会发起一次真实上游请求。"
          : lastGatewayTest.success
            ? "最近一次网关自测成功。"
            : `最近一次自测失败${lastGatewayTest.errorCode === null ? "" : `：${lastGatewayTest.errorCode}`}`,
      action: { page: "diagnostics" },
    },
  ];

  const readyForInference =
    secretsComplete &&
    providersWithAccounts > 0 &&
    enabledModels > 0 &&
    configPublished &&
    activeApiKeys > 0;

  return c.json({
    data: {
      readyForInference,
      secrets,
      counts: {
        providers,
        providersWithAccounts,
        providersWithModels,
        models,
        enabledModels,
        activeApiKeys,
      },
      config: {
        activeVersion: config.activeVersion,
        pendingChanges: config.pendingChanges,
        valid: configValid,
        issues,
      },
      lastGatewayTest,
      steps,
    },
  });
}

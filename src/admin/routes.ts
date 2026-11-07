import type { Hono } from "hono";
import type { AppEnv } from "../app";
import { requireAdmin } from "../auth/middleware";
import {
  createAccountHandler,
  createProviderHandler,
  deleteAccountHandler,
  deleteProviderHandler,
  getProviderHandler,
  listAccountsHandler,
  listProviderHandler,
  refreshModelMetadataHandler,
  syncModelsHandler,
  testProviderHandler,
  updateAccountHandler,
  updateProviderHandler,
} from "./handlers/providers";
import {
  createModelHandler,
  createPricingHandler,
  deleteModelHandler,
  deletePricingHandler,
  getModelHandler,
  listModelsHandler,
  listPricingHandler,
  updateModelHandler,
} from "./handlers/models";
import {
  createComboHandler,
  deleteComboHandler,
  getComboHandler,
  listCombosHandler,
  previewComboHandler,
  updateComboHandler,
  validateComboHandler,
} from "./handlers/combos";
import {
  createApiKeyHandler,
  createUserHandler,
  deleteApiKeyHandler,
  getUserHandler,
  listApiKeysHandler,
  listUsersHandler,
  rotateApiKeyHandler,
  updateApiKeyHandler,
  updateUserHandler,
} from "./handlers/keys";
import { breakerHealthHandler } from "./handlers/health";
import { getSettingsHandler, updateSettingsHandler } from "./handlers/settings";
import {
  listProviderPresetsHandler,
  setupStatusHandler,
} from "./handlers/setup";
import {
  gatewayTestHandler,
  routingExplainHandler,
} from "./handlers/diagnostics";
import {
  getRequestHandler,
  listRequestsHandler,
  usageSummaryHandler,
} from "./handlers/usage";
import {
  adminHealthHandler,
  currentConfigHandler,
  listAuditLogsHandler,
  listConfigVersionsHandler,
  publishConfigHandler,
  rollbackConfigHandler,
  validateConfigHandler,
} from "./handlers/config";

export function registerAdminRoutes(app: Hono<AppEnv>): void {
  app.use("/admin/*", requireAdmin);

  // Provider 与账户
  app.get("/admin/providers", listProviderHandler);
  app.post("/admin/providers", createProviderHandler);
  app.get("/admin/providers/:id", getProviderHandler);
  app.put("/admin/providers/:id", updateProviderHandler);
  app.delete("/admin/providers/:id", deleteProviderHandler);
  app.post("/admin/providers/:id/test", testProviderHandler);
  app.post("/admin/providers/:id/sync-models", syncModelsHandler);
  app.post("/admin/providers/:id/refresh-model-metadata", refreshModelMetadataHandler);
  app.get("/admin/providers/:id/accounts", listAccountsHandler);
  app.post("/admin/providers/:id/accounts", createAccountHandler);
  app.put("/admin/providers/:id/accounts/:accountId", updateAccountHandler);
  app.delete("/admin/providers/:id/accounts/:accountId", deleteAccountHandler);

  // 模型与价格
  app.get("/admin/models", listModelsHandler);
  app.post("/admin/models", createModelHandler);
  app.get("/admin/models/:id", getModelHandler);
  app.put("/admin/models/:id", updateModelHandler);
  app.delete("/admin/models/:id", deleteModelHandler);
  app.get("/admin/pricing", listPricingHandler);
  app.post("/admin/pricing", createPricingHandler);
  app.delete("/admin/pricing/:id", deletePricingHandler);

  // 通配符
  // Combo
  app.get("/admin/combos", listCombosHandler);
  app.post("/admin/combos", createComboHandler);
  app.get("/admin/combos/:id", getComboHandler);
  app.put("/admin/combos/:id", updateComboHandler);
  app.delete("/admin/combos/:id", deleteComboHandler);
  app.post("/admin/combos/:id/validate", validateComboHandler);
  app.post("/admin/combos/:id/preview", previewComboHandler);

  // 用户与 API Key
  app.get("/admin/users", listUsersHandler);
  app.post("/admin/users", createUserHandler);
  app.get("/admin/users/:id", getUserHandler);
  app.put("/admin/users/:id", updateUserHandler);
  app.get("/admin/api-keys", listApiKeysHandler);
  app.post("/admin/api-keys", createApiKeyHandler);
  app.put("/admin/api-keys/:id", updateApiKeyHandler);
  app.delete("/admin/api-keys/:id", deleteApiKeyHandler);
  app.post("/admin/api-keys/:id/rotate", rotateApiKeyHandler);

  // 用量与请求日志
  app.get("/admin/usage", usageSummaryHandler);
  app.get("/admin/usage/summary", usageSummaryHandler);
  app.get("/admin/requests", listRequestsHandler);
  app.get("/admin/requests/:id", getRequestHandler);

  // 配置版本
  app.get("/admin/config/current", currentConfigHandler);
  app.post("/admin/config/validate", validateConfigHandler);
  app.post("/admin/config/publish", publishConfigHandler);
  app.get("/admin/config/versions", listConfigVersionsHandler);
  app.post("/admin/config/rollback", rollbackConfigHandler);

  // 快速开始、预设与诊断
  app.get("/admin/provider-presets", listProviderPresetsHandler);
  app.get("/admin/setup/status", setupStatusHandler);
  app.post("/admin/routing/explain", routingExplainHandler);
  app.post("/admin/gateway/test", gatewayTestHandler);

  // 审计与健康
  app.get("/admin/settings", getSettingsHandler);
  app.put("/admin/settings", updateSettingsHandler);
  app.get("/admin/audit-logs", listAuditLogsHandler);
  app.get("/admin/health", adminHealthHandler);
  app.get("/admin/health/breakers", breakerHealthHandler);
}

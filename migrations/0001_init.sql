-- FufuGateway 初始数据库结构
-- 所有时间字段为 Unix 毫秒（INTEGER）；JSON 字段以 TEXT 存储。

-- ---------------------------------------------------------------------------
-- 用户与租户
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  email TEXT,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (role IN ('admin', 'user')),
  CHECK (status IN ('active', 'disabled'))
);
CREATE UNIQUE INDEX ux_users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX ix_users_tenant ON users(tenant_id);

-- ---------------------------------------------------------------------------
-- 下游 API Key
-- 仅保存带 pepper 的 SHA-256 哈希与前缀，禁止保存明文。
-- ---------------------------------------------------------------------------
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '["inference"]',
  model_allowlist TEXT,
  provider_allowlist TEXT,
  rpm_limit INTEGER,
  tpm_limit INTEGER,
  concurrency_limit INTEGER,
  daily_budget_usd REAL,
  monthly_budget_usd REAL,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  rotated_from TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  CHECK (status IN ('active', 'disabled', 'revoked')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ux_api_keys_hash ON api_keys(key_hash);
CREATE INDEX ix_api_keys_user ON api_keys(user_id);
CREATE INDEX ix_api_keys_status ON api_keys(status);

-- ---------------------------------------------------------------------------
-- 上游 Provider
-- protocol 表示上游使用的协议族；type 表示适配器类型。
-- ---------------------------------------------------------------------------
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  type TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  weight INTEGER NOT NULL DEFAULT 1,
  custom_headers TEXT,
  timeout_ms INTEGER NOT NULL DEFAULT 60000,
  first_token_timeout_ms INTEGER NOT NULL DEFAULT 20000,
  idle_timeout_ms INTEGER NOT NULL DEFAULT 60000,
  max_retries INTEGER NOT NULL DEFAULT 2,
  retry_config TEXT,
  proxy_config TEXT,
  extra_config TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (type IN ('OPENAI_COMPATIBLE', 'ANTHROPIC', 'GOOGLE_GEMINI', 'CUSTOM')),
  CHECK (protocol IN ('openai-chat', 'openai-responses', 'anthropic', 'gemini'))
);
CREATE INDEX ix_providers_enabled ON providers(enabled, priority);

-- ---------------------------------------------------------------------------
-- 上游账户（同一 Provider 可配置多个 API Key）
-- api_key_enc/iv/tag 为 AES-256-GCM 密文；secret_ref 为 Worker Secret 名称。
-- ---------------------------------------------------------------------------
CREATE TABLE provider_accounts (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  api_key_enc TEXT,
  api_key_iv TEXT,
  api_key_tag TEXT,
  secret_ref TEXT,
  weight INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  cooldown_until INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (provider_id, name),
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
  CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'unhealthy'))
);
CREATE INDEX ix_accounts_provider ON provider_accounts(provider_id, enabled);

-- ---------------------------------------------------------------------------
-- 模型目录
-- model_id 为网关对外暴露的模型标识；upstream_model_id 为上游真实标识。
-- ---------------------------------------------------------------------------
CREATE TABLE models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  upstream_model_id TEXT NOT NULL,
  display_name TEXT,
  input_modalities TEXT NOT NULL DEFAULT '["text"]',
  output_modalities TEXT NOT NULL DEFAULT '["text"]',
  context_window INTEGER,
  max_output_tokens INTEGER,
  supports_stream INTEGER NOT NULL DEFAULT 1,
  supports_tools INTEGER NOT NULL DEFAULT 0,
  supports_parallel_tools INTEGER NOT NULL DEFAULT 0,
  supports_json_schema INTEGER NOT NULL DEFAULT 0,
  supports_reasoning INTEGER NOT NULL DEFAULT 0,
  supports_vision INTEGER NOT NULL DEFAULT 0,
  supports_audio INTEGER NOT NULL DEFAULT 0,
  supports_video INTEGER NOT NULL DEFAULT 0,
  supports_prompt_cache INTEGER NOT NULL DEFAULT 0,
  input_price REAL,
  output_price REAL,
  cached_input_price REAL,
  reasoning_price REAL,
  price_unit TEXT NOT NULL DEFAULT 'per_million_tokens',
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (provider_id, model_id),
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
);
CREATE INDEX ix_models_model_id ON models(model_id);
CREATE INDEX ix_models_provider ON models(provider_id);

-- ---------------------------------------------------------------------------
-- 模型别名（虚拟模型）
-- target 为 JSON 路由目标，发布期解析并校验。
-- ---------------------------------------------------------------------------
CREATE TABLE model_aliases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  target TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 通配符虚拟模型
-- pattern 为安全 Glob（仅 * 与 ?），targets 为 JSON 数组。
-- ---------------------------------------------------------------------------
CREATE TABLE wildcard_rules (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL UNIQUE,
  strategy TEXT NOT NULL DEFAULT 'fallback',
  targets TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ix_wildcards_enabled ON wildcard_rules(enabled, priority DESC);

-- ---------------------------------------------------------------------------
-- Combo 编排
-- nodes 为 JSON 节点数组；运行期使用发布期归一化结果。
-- ---------------------------------------------------------------------------
CREATE TABLE combos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  description TEXT,
  strategy TEXT NOT NULL DEFAULT 'fallback',
  nodes TEXT NOT NULL,
  timeout_ms INTEGER,
  max_concurrency INTEGER,
  sticky TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ix_combos_enabled ON combos(enabled);

-- ---------------------------------------------------------------------------
-- 价格覆盖（按 Provider + 上游模型）
-- ---------------------------------------------------------------------------
CREATE TABLE pricing (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  input_price REAL NOT NULL,
  output_price REAL NOT NULL,
  cached_input_price REAL,
  reasoning_price REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  effective_from INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (provider_id, model_id)
);

-- ---------------------------------------------------------------------------
-- 系统设置（JSON 值）
-- ---------------------------------------------------------------------------
CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 配置版本（快照与回滚）
-- ---------------------------------------------------------------------------
CREATE TABLE config_versions (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  checksum TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  note TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  CHECK (status IN ('published', 'superseded', 'rolled_back', 'failed'))
);
CREATE INDEX ix_config_versions_created ON config_versions(created_at DESC);

-- ---------------------------------------------------------------------------
-- 请求日志
-- ---------------------------------------------------------------------------
CREATE TABLE request_logs (
  request_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  user_id TEXT,
  api_key_id TEXT,
  provider_id TEXT,
  provider_account_id TEXT,
  requested_model TEXT NOT NULL,
  actual_model TEXT,
  combo_id TEXT,
  source_protocol TEXT NOT NULL,
  target_protocol TEXT,
  stream INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  usage_source TEXT NOT NULL DEFAULT 'none',
  estimated_cost REAL NOT NULL DEFAULT 0,
  actual_cost REAL NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  first_token_at INTEGER,
  finished_at INTEGER,
  duration_ms INTEGER,
  status TEXT NOT NULL,
  error_code TEXT,
  http_status INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  route_trace TEXT,
  created_at INTEGER NOT NULL,
  CHECK (status IN ('success', 'error', 'cancelled'))
);
CREATE INDEX ix_request_logs_created ON request_logs(created_at DESC);
CREATE INDEX ix_request_logs_user ON request_logs(user_id, created_at DESC);
CREATE INDEX ix_request_logs_key ON request_logs(api_key_id, created_at DESC);
CREATE INDEX ix_request_logs_combo ON request_logs(combo_id, created_at DESC);
CREATE INDEX ix_request_logs_model ON request_logs(actual_model, created_at DESC);
CREATE INDEX ix_request_logs_status ON request_logs(status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 用量日汇总（按 UTC 日期分桶）
-- ---------------------------------------------------------------------------
CREATE TABLE usage_rollups (
  day TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  api_key_id TEXT NOT NULL DEFAULT '',
  provider_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  combo_id TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, user_id, api_key_id, provider_id, model, combo_id)
);
CREATE INDEX ix_usage_rollups_key ON usage_rollups(api_key_id, day);
CREATE INDEX ix_usage_rollups_user ON usage_rollups(user_id, day);

-- ---------------------------------------------------------------------------
-- 预算计数器（由 Usage 消费者幂等累加，并可由 D1 日志重建）
-- ---------------------------------------------------------------------------
CREATE TABLE budget_counters (
  scope TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  period TEXT NOT NULL,
  spend_usd REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, subject_type, subject_id, period),
  CHECK (scope IN ('day', 'month')),
  CHECK (subject_type IN ('user', 'api_key'))
);

-- ---------------------------------------------------------------------------
-- 审计日志
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX ix_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX ix_audit_logs_actor ON audit_logs(actor_id, created_at DESC);

-- 默认系统设置
INSERT INTO system_settings (key, value, updated_at) VALUES
  ('gateway.name', '"FufuGateway"', unixepoch('now') * 1000),
  ('compat.default_policy', '"warn"', unixepoch('now') * 1000),
  ('limits.max_body_bytes', '4194304', unixepoch('now') * 1000),
  ('limits.max_response_bytes', '16777216', unixepoch('now') * 1000),
  ('limits.max_stream_event_bytes', '1048576', unixepoch('now') * 1000),
  ('limits.max_combo_depth', '16', unixepoch('now') * 1000),
  ('limits.max_combo_nodes', '256', unixepoch('now') * 1000),
  ('limits.max_combo_concurrency', '8', unixepoch('now') * 1000),
  ('timeouts.request_ms', '300000', unixepoch('now') * 1000),
  ('logging.retention_days', '30', unixepoch('now') * 1000),
  ('cors.allowed_origins', '[]', unixepoch('now') * 1000),
  ('config.cache_ttl_ms', '60000', unixepoch('now') * 1000);

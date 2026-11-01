-- 上游账户密钥改为明文存储。
-- api_key_plain 保存通过管理 API 提交的 apiKey；secret_ref 仍可引用 Worker Secret。
ALTER TABLE provider_accounts ADD COLUMN api_key_plain TEXT;

-- 历史遗留列：api_key_enc / api_key_iv / api_key_tag 不再读写。
-- 保留列定义以兼容已部署的 D1 与回滚场景。

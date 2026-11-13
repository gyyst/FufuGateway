-- 下游 API Key 明文存储，用于管理端随时查看与复制。
-- 认证仍使用 key_hash；key_plain 仅供单条 reveal 接口返回，且访问会写入审计。
-- 升级前创建的 Key 该列为 NULL，需要轮换后才能查看明文。
ALTER TABLE api_keys ADD COLUMN key_plain TEXT;

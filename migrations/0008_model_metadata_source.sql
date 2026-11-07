-- 模型元数据来源：manual / upstream / models.dev / unknown
-- 旧的手工模型保持 manual；旧的同步模型标记 unknown，允许“刷新元数据”补空缺。
ALTER TABLE models ADD COLUMN metadata_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE models ADD COLUMN metadata_updated_at INTEGER;

UPDATE models SET metadata_source = 'unknown' WHERE source = 'sync';

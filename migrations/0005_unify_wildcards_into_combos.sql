-- 把通配符规则合并为 glob Combo：名称即 pattern，目标即 nodes。
ALTER TABLE combos ADD COLUMN priority INTEGER NOT NULL DEFAULT 100;

INSERT OR IGNORE INTO combos
  (id, name, description, strategy, nodes, judge_model, timeout_ms, max_concurrency,
   sticky, priority, enabled, created_at, updated_at)
SELECT
  w.id,
  CASE
    WHEN EXISTS (SELECT 1 FROM combos c WHERE c.name = w.pattern COLLATE NOCASE)
      THEN w.pattern || '-glob-' || substr(w.id, -4)
    ELSE w.pattern
  END,
  w.description,
  w.strategy,
  w.targets,
  NULL,
  NULL,
  NULL,
  NULL,
  w.priority,
  w.enabled,
  w.created_at,
  w.updated_at
FROM wildcard_rules w;

DROP TABLE wildcard_rules;

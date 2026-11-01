-- 把别名合并为单节点 Combo：target 作为唯一节点，策略 fallback。
INSERT OR IGNORE INTO combos
  (id, name, description, strategy, nodes, judge_model, timeout_ms, max_concurrency,
   sticky, priority, enabled, created_at, updated_at)
SELECT
  a.id,
  CASE
    WHEN EXISTS (SELECT 1 FROM combos c WHERE c.name = a.name COLLATE NOCASE)
      THEN a.name || '-alias-' || substr(a.id, -4)
    ELSE a.name
  END,
  a.description,
  'fallback',
  '[' || a.target || ']',
  NULL,
  NULL,
  NULL,
  NULL,
  a.priority,
  a.enabled,
  a.created_at,
  a.updated_at
FROM model_aliases a;

DROP TABLE model_aliases;

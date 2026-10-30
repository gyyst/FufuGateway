-- 用户级限流与预算
ALTER TABLE users ADD COLUMN rpm_limit INTEGER;
ALTER TABLE users ADD COLUMN tpm_limit INTEGER;
ALTER TABLE users ADD COLUMN concurrency_limit INTEGER;
ALTER TABLE users ADD COLUMN daily_budget_usd REAL;
ALTER TABLE users ADD COLUMN monthly_budget_usd REAL;

# 执行计划：API Key 随时查看与复制

## Checklist

1. 新增迁移 `migrations/0009_api_key_plaintext.sql`。
2. 更新 `src/auth/types.ts`、`src/auth/repository.ts`，映射与写入 `keyPlain`。
3. 更新 `src/admin/handlers/keys.ts`：创建/轮换写入明文、`publicApiKey` 脱敏、新增 reveal handler。
4. 更新 `src/admin/routes.ts` 注册 `GET /admin/api-keys/:id/reveal`。
5. 更新 `public/ui-static/app.js`：查看操作、复制兜底、文案。
6. 新增 `test/integration/api-key-reveal.test.ts`。
7. 更新 `README.md` 与 `.trellis/spec/backend/security-guidelines.md`。
8. 运行 `npm run typecheck`、`npm test`。

## Validation

- `npm run typecheck`
- `npm test`
- 手动检查列表响应不含明文与 `keyHash`。

## Rollback

- 代码回滚后 `key_plain` 列为惰性列；认证逻辑未改动。

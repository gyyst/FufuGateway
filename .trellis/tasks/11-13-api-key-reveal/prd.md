# 下游 API Key 支持随时查看与复制

## Goal

管理台创建的下游 API Key 不再只在创建/轮换时显示一次明文。管理员可在 API Key 列表中随时查看并复制已有 Key，便于客户端配置和迁移。

## Requirements

- `api_keys` 增加明文存储列；认证仍使用现有 `key_hash`，不改变鉴权路径。
- 创建与轮换时把明文写入数据库，并继续在响应中返回明文。
- 列表接口不批量返回明文；新增单条 reveal 接口按需返回，并记录审计（不记录明文本身）。
- 管理台 API Key 列表增加「查看」操作，弹窗展示明文并提供复制按钮；复制失败时可一键选中文本手动复制。
- 升级前创建的旧 Key 没有明文，查看时给出明确提示，引导使用「轮换」生成可查看的新 Key。
- 更新安全规范 `security-guidelines.md` 与 `README.md`，说明下游 Key 明文存储的决策与风险。

## Acceptance Criteria

- [ ] 创建 API Key 后，`GET /admin/api-keys/:id/reveal` 返回与创建响应一致的明文。
- [ ] 列表接口 `GET /admin/api-keys` 的响应不包含明文、`keyHash` 或 `key_hash`。
- [ ] 轮换生成的新 Key 可 reveal；被吊销的旧 Key 不再可用。
- [ ] 旧数据（`key_plain IS NULL`）调用 reveal 返回可理解的错误，管理台提示轮换。
- [ ] reveal 调用在 `audit_logs` 中留下 `api_key.reveal` 记录，且 details 不含明文。
- [ ] 管理台列表可直接查看并复制明文，复制失败时可手动选中。
- [ ] `npm run typecheck` 与 `npm test` 通过。

## Notes

- 方案已与用户确认：采用明文存储（与上游 Provider Key 的现有策略一致），不引入 `ENCRYPTION_KEY`。
- 认证路径必须继续按 `key_hash` 查询，明文列只服务于管理端展示。

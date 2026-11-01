# 保存即自动发布配置，取消手动发布环节

## Goal

取消管理端“配置发布”这一手动环节：所有配置写入保存成功后自动生成版本并切换生效，同时保留版本历史与回滚。目标是消除“已保存但忘记发布，推理入口仍使用旧配置”的故障模式。

## Background（已确认事实）

- 运行时配置由 `providers / provider_accounts / models / combos / pricing / system_settings` 六类数据组成（`src/config/repository.ts:372-382`）。
- 运行时读取顺序：KV 当前指针 → 版本快照；无版本时回退 D1；每个 isolate 内存缓存最多 `config.cache_ttl_ms`（默认 60 秒）（`src/config/cache.ts:81-104`）。
- 手动发布流程会校验配置、按 checksum 去重、写入 `config_versions`、写 KV 快照与当前指针、把旧版本标记 superseded，并清理当前 isolate 缓存（`src/config/snapshot.ts:63-125`）。
- 手动入口：`POST /admin/config/publish`（`src/admin/routes.ts:128`、`src/admin/handlers/config.ts:40-51`）与管理台“配置与审计”页发布按钮（`public/ui-static/app.js:4197-4215`）；快速开始清单把“发布配置版本”列为独立步骤（`src/admin/handlers/setup.ts:172-184`）。
- 配置写入路径：providers/accounts/models/pricing/combos/settings 的管理端处理器，以及 `sync-models` 与每日定时同步（`src/models/sync.ts`、`src/maintenance.ts`）。
- 校验规则：Provider 无账户只是 warning；重名、非法 URL/协议、账户无凭据、模型/Combo 引用不存在、启用的 Combo 目标无法解析、设置越界等为 error（`src/config/validate.ts`）。
- 现有测试覆盖“先创建引用不存在目标的 Combo、再创建目标”的中间态（`test/integration/gateway.test.ts:306-332`、`test/integration/config.test.ts:132-157`）。
- 回滚目前只切 KV 指针，不修改 D1（`src/config/snapshot.ts:128-170`）。
- 跨 isolate 生效仍受 KV 传播与内存缓存 TTL 限制，最长约 60 秒。

## Requirements

- R1：所有配置数据写入成功后自动发布，不再需要用户手动点击发布。
- R2：仅当配置 checksum 变化时生成新版本；无变化的保存不产生新版本。
- R3：保留 `config_versions` 历史与回滚能力，回滚语义需与自动发布兼容。
- R4：管理台移除发布按钮、待发布横幅与快速开始中的“发布配置版本”步骤，改为展示当前生效版本与最近一次自动发布结果。
- R5：`POST /admin/config/publish` 保留为兼容与故障恢复入口，从日常 UI 流程移除并标记 deprecated。
- R6：非法配置采用“保存但不生效”：写入保留、旧版本继续服务、响应返回 `config.applied=false` 与校验问题；下一次合法写入自动收敛。
- R7：非 HTTP 写入路径（模型同步、定时任务）也必须自动发布，避免 D1 与生效版本长期分叉。
- R8：回滚同时恢复 D1 并重新激活目标版本，确保后续保存不会撤销回滚。
- R9：配置写入响应新增顶层 `config` 结果字段，不破坏现有响应结构。
- R10：更新相关测试与文档（`docs/API.md`、`docs/DEPLOY.md`、`docs/ARCHITECTURE.md`、`examples/bootstrap.sh`、README）。

## Decisions

- 自动发布采用同步执行：写入 D1 成功后立即加载、校验并发布，响应携带结果。
- 版本 note 使用 `auto:<action>`，createdBy 记录当前管理员；“维护任务”使用 `system`。
- 自动发布失败不阻断实体写入；失败原因通过 `config` 字段、管理台提示与 `pendingChanges` 暴露。
- 回滚拒绝包含旧版 `aliases` / `wildcards` 的快照；升级前加密格式的旧版本会因账户无凭据被校验拒绝。
- 不新增数据库迁移，不改变快照格式。

## Acceptance Criteria

- [ ] 任意配置写入接口成功后，无需额外操作，运行时读取到新配置（在缓存 TTL 内）。
- [ ] 连续保存相同配置不新增版本。
- [ ] 版本列表仍可查看，回滚仍可用，且回滚后 D1 与生效版本一致，后续保存不会复活被回滚的配置。
- [ ] 管理台不再出现“发布配置”按钮或“待发布变更”提示；发布失败或校验失败时显示“未生效”及原因。
- [ ] 同步模型与定时任务产生的配置变化同样自动发布。
- [ ] 非法配置写入返回成功状态码 + `config.applied=false`，旧版本继续服务；修复后自动收敛。
- [ ] `npm run typecheck`、`npm test`、`npm run deploy:dry-run` 通过。

## Out of Scope

- 不改变配置数据模型与 KV 快照格式。
- 不实现跨 isolate 的强一致即时生效；继续接受缓存 TTL/KV 传播延迟。
- 不实现配置版本自动清理策略。
- 不改变鉴权、限流、用量等功能。
- 不引入配置广播或 Durable Object 版本协调机制。

## Open Questions

- 无阻塞问题；R6 与 R8 的方案已在 `design.md` 中给出，等待你审阅确认。

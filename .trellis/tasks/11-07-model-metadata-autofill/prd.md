# 模型能力自动识别：图像与上下文长度

## Goal

参考 Magpie 的模型目录能力，在同步上游模型时自动获取并填充模型的输入/输出模态（尤其是图像）、上下文窗口、最大输出 Token、工具调用、JSON Schema、推理、Prompt Cache 与价格等元数据。元数据优先来自上游 `/models` 的实时字段，缺失时按模型 ID 匹配 models.dev 目录兜底。

识别到可用元数据的文本模型自动启用；未识别元数据的模型保持禁用，避免按名称猜测能力。已存在的旧模型提供“刷新元数据”能力，只补空缺，不覆盖管理员手工修改。

## Background

当前 `syncProviderModels` 对每个新模型统一写入：

- `enabled: false`
- 全部能力为 `false`
- 只有 Gemini 的 `/models` 解析了 `inputTokenLimit` / `outputTokenLimit`
- OpenAI 兼容与 Anthropic 的 `/models` 只解析 ID、显示名和时间

管理员同步后需要在“编辑并确认能力”表单中逐项手工填写上下文窗口、图像、工具、推理等字段，成本高且容易出错。Magpie 的做法是：

1. 解析上游 `/models` 实时返回的 `context_length`、`modalities`、`architecture`、`supported_parameters` 等字段。
2. 拉取并缓存 models.dev 目录（`https://models.dev/api.json`），按模型 ID 匹配，补齐缺失字段。
3. 模型 ID 支持厂商前缀、大小写、点/横线差异、快照日期后缀、方括号窗口标记等归一化。
4. 上游字段优先，models.dev 只做兜底。

FufuGateway 已有 D1 `models` 表的完整能力字段，适合直接落库；`CONFIG_KV` 可用于缓存压缩后的 models.dev 目录。

## Users and Scenarios

### 场景 A：首次同步 Provider 模型

管理员添加 Provider 和账户后点击“同步模型”：

- 上游返回 `gpt-5.4`、`qwen3-vl-30b-a3b` 等模型。
- 网关自动填充上下文窗口、图像输入、工具、推理、价格。
- 识别到的文本模型自动启用；未识别的模型（如自定义微调名）保持禁用，并明确提示需要人工确认。

### 场景 B：同步自定义/中转端点

Provider 是自定义 OpenAI 兼容地址，上游只返回模型 ID。网关按模型 ID 在 models.dev 中跨 Provider 匹配（支持 `deepseek/deepseek-chat`、`GLM-5.3-Flash`、`glm-5-3-flash-260828` 等写法），补齐元数据；仍无法识别的模型保持禁用。

### 场景 C：回填旧模型

升级前已同步的模型能力全为 `false`。管理员在 Provider 设置中点击“刷新元数据”：

- 重新拉取上游模型列表并匹配 models.dev。
- 只填充空字段（未设置上下文、全 `false` 的能力、价格为 0、缺少显示名）。
- 不覆盖已有非空值，不改变 `enabled` 状态。
- 手工编辑过能力的模型标记为手动，刷新时跳过。

### 场景 D：管理员手工修正

管理员在模型表单中修改能力后，该模型标记为“手动”，后续自动同步和刷新不会覆盖其能力字段。

## Requirements

### R1. 上游 `/models` 元数据解析

- OpenAI 兼容解析需支持常见字段别名：
  - 上下文：`context_length`、`context_window`、`max_context_length`、`max_model_len`、`input_token_limit`、`inputTokenLimit`、`top_provider.context_length`。
  - 最大输出：`max_output_tokens`、`max_completion_tokens`、`output_token_limit`、`outputTokenLimit`、`top_provider.max_completion_tokens`。
  - 模态：`architecture.input_modalities`、`architecture.output_modalities`、`input_modalities`、`output_modalities`、`modalities.input`、`modalities.output`。
  - 能力：`tool_call`、`supports_tools`、`structured_output`、`supports_json_schema`、`reasoning`、`supports_reasoning`、`supports_vision` 等。
  - 价格：OpenRouter 的 `pricing.prompt` / `pricing.completion` / `pricing.input_cache_read`（每 Token 美元）需换算为每百万 Token。
- 模态映射：
  - 输入：`text` / `image` / `audio` / `video` 保留；`pdf`、`file` 映射为 `file`；未知值丢弃。
  - 输出：`text` / `image` / `audio` / `embedding` 保留；未知值丢弃。
- Gemini 继续解析 `inputTokenLimit` / `outputTokenLimit`，并同步解析模态（如返回 `supportedGenerationMethods` 等能力字段则不强制）。
- Anthropic 保持现有 ID/显示名解析，不伪造未返回的字段。

### R2. models.dev 目录与缓存

- 拉取 `https://models.dev/api.json`，压缩为只包含所需字段的目录：
  - Provider：`id`、`name`、模型表。
  - 模型：`id`、`name`、上下文、最大输出、输入/输出模态、工具、JSON Schema、推理、Prompt Cache、价格。
- 缓存到 `CONFIG_KV`，键为 `model_catalog:models.dev:v1`，TTL 24 小时。
- 每个 Worker isolate 使用内存缓存，避免同一请求链重复解析。
- 并发加载合并为单个 Promise。
- KV 读取失败或远端不可用时：
  - 有旧缓存则使用旧缓存（stale fallback）。
  - 完全没有缓存则返回空目录；同步继续，不因目录不可用而失败。
- 同步响应返回目录状态：`ok` / `stale` / `unavailable`。
- 不记录、不返回任何上游密钥。

### R3. 模型匹配

- Provider 匹配优先级：
  1. `extraConfig.modelsDevProvider`（字符串；显式指定 models.dev Provider ID）。
  2. Base URL 主机名映射（OpenAI、Anthropic、Google、OpenRouter、DeepSeek、Moonshot、Z.AI/智谱、阿里云百炼、Mistral、Groq、xAI、Together、Fireworks、SiliconFlow、火山方舟等）。
  3. Provider 名称与 models.dev Provider ID / 显示名精确（归一化后）匹配。
- 模型匹配优先级：
  1. 命中 Provider 的模型表中按原始 ID 精确匹配。
  2. 去掉 `vendor/` 前缀后匹配。
  3. 归一化匹配：忽略大小写、下划线/空格、点号与横线差异、六位或八位快照日期后缀、末尾方括号标记。
  4. Provider 内仍无结果时，跨 Provider 按归一化 ID 匹配；多个 Provider 值冲突时按多数值合并。
- 末尾 `[1m]`、`[200k]` 等窗口标记同时作为 `contextWindow` 的候选值。
- 允许通过 `extraConfig.modelsDevProvider` 限定 Provider，降低跨 Provider 误匹配。

### R4. 同步行为

- 新模型写入合并后的元数据：
  - 上游实时字段优先。
  - models.dev 补齐缺失字段。
  - 显示名、上下文、最大输出、输入/输出模态、工具、JSON Schema、推理、Prompt Cache、价格。
- 自动启用规则：
  - 识别到元数据（models.dev 命中，或上游返回了上下文/模态/能力字段）。
  - 输出模态包含 `text` 或未知（按文本模型处理）。
  - 输出模态明确为纯图像/音频/embedding 的模型不自动启用。
  - 可通过 `extraConfig.syncAutoEnable = false` 关闭自动启用。
- 未识别元数据的模型保持 `enabled=false`、能力为空。
- 所有同步模型仍允许管理员在 UI 中确认或修改。
- 同步结果新增统计：元数据命中数、上游命中数、未识别数、自动启用数、目录状态。
- `requiresConfirmation` 仅在仍有新建模型保持禁用时为 `true`。

### R5. 存量模型刷新

- 新增管理员接口 `POST /admin/providers/:id/refresh-model-metadata`：
  - 若 Provider 有可用账户，拉取上游 `/models`；无账户时只使用 models.dev。
  - 对 Provider 下所有 `metadataSource != "manual"` 的模型执行“只补空缺”：
    - 未设置 `contextWindow` / `maxOutputTokens` 时填充。
    - 当前输入/输出模态仅为默认 `["text"]` 且合并结果更丰富时替换。
    - 能力布尔值只从 `false` 提升为 `true`，不回退。
    - 价格仅在输入/输出价格均为 0 时填充。
    - 缺少显示名时填充。
    - 不改变 `enabled`。
  - 返回 `updated`、`unchanged`、`skippedManual`、`unmatched` 统计。
- 模型被管理员手工修改能力字段后 `metadataSource = "manual"`，刷新跳过。
- 仅修改 `enabled`、显示名或价格不视为手工修改能力，仍可自动补空缺。

### R6. 管理 API 与 UI

- 模型记录新增：
  - `metadataSource`：`manual` / `upstream` / `models.dev` / `unknown`。
  - `metadataUpdatedAt`：最近一次自动或手工更新元数据的时间。
- 管理 API 的模型对象返回上述字段。
- Provider 设置面板：
  - 同步提示更新为“自动识别能力与上下文，未识别的模型保持禁用”。
  - 新增“刷新元数据”按钮。
  - 扩展配置新增 `modelsDevProvider` 与 `syncAutoEnable` 可视化字段。
- 模型列表新增“上下文”和“元数据来源”列；能力列继续显示 stream/tools/vision/reasoning。
- 模型编辑表单说明：自动识别的字段可在保存时确认；保存能力字段后标记为手动。
- UI 保持零构建原生 JS，不引入前端框架。

### R7. 文档与测试

- 更新 `docs/PROVIDERS.md` 的模型同步章节。
- 更新 `docs/API.md` 的管理接口表。
- 更新 `README.md` 的能力/同步描述（如适用）。
- 新增/更新单元与集成测试，见验收标准。

## Non-Goals

- 不自动推断模型名称中没有依据的能力；仍以数据源为准。
- 不实现订阅 OAuth、账户发现或 Magpie 的本地配置改写。
- 不实现模型价格自动更新任务（仅同步/刷新时更新）。
- 不引入前端框架或新的外部运行依赖。
- 不改变四协议转换、路由、Combo、限流与用量逻辑。
- 不自动启用识别到元数据但输出为纯图像/音频/embedding 的模型。

## Constraints

- 兼容 Cloudflare Workers Runtime，不引入 Node 专用 API。
- 不新增明文密钥；models.dev 目录是公开数据。
- models.dev 为外部服务，失败必须降级，不能阻塞同步。
- KV 值上限与 Worker 内存限制内工作；目录压缩后约 2–3 MB。
- 管理 API 仅管理员可访问。
- 不破坏现有配置快照、发布、回滚流程。
- 不修改现有 `huawei` 等线上配置，除非管理员主动执行同步/刷新。

## Acceptance Criteria

- [ ] 上游返回 `context_length`、`architecture.input_modalities`、`pricing` 时，同步后的模型包含正确上下文、`supportsVision`、模态和价格。
- [ ] models.dev 命中时，同步模型补齐上下文、最大输出、图像、工具、JSON Schema、推理、Prompt Cache、价格和显示名。
- [ ] 模型 ID 支持 `vendor/` 前缀、大小写、点/横线差异、快照日期后缀与 `[1m]` 窗口标记。
- [ ] 识别到元数据的文本模型自动启用；未识别元数据的模型保持禁用且能力为空。
- [ ] 纯图像输出模型不会被自动启用。
- [ ] `extraConfig.syncAutoEnable = false` 时所有同步模型保持禁用。
- [ ] 旧同步模型可通过“刷新元数据”补齐空缺，且不覆盖已有非空值、不改变启用状态。
- [ ] 手工编辑能力的模型标记为 `manual`，刷新时跳过。
- [ ] models.dev 不可用时同步仍成功，目录状态为 `unavailable`；有旧缓存时使用旧缓存。
- [ ] 第二次同步/刷新复用 KV 缓存，不重复下载 models.dev。
- [ ] 管理 UI 展示上下文与元数据来源，并提供刷新入口。
- [ ] `npm run typecheck` 通过。
- [ ] `npm test` 全部通过，并覆盖上述新增行为。
- [ ] `npm run deploy:dry-run` 通过。
- [ ] 文档更新完成。

## Notes

- models.dev 是公开模型目录（https://models.dev），字段会随生态变化；实现必须对缺失字段宽容，不能因目录结构变化抛错。
- 自动启用是产品决策：识别到数据源给出的元数据即可启用；管理员仍可随时停用或修正。
- 元数据来源仅用于展示与刷新策略，不进入路由决策。

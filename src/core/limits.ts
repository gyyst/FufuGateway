/** 全局硬限制。可被系统设置覆盖的部分在配置快照中单独处理。 */

export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_STREAM_EVENT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_ERROR_BODY_BYTES = 64 * 1024;

export const DEFAULT_MAX_COMBO_DEPTH = 16;
export const DEFAULT_MAX_COMBO_NODES = 256;
export const DEFAULT_MAX_COMBO_CONCURRENCY = 8;
export const HARD_MAX_COMBO_CONCURRENCY = 32;

export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 20_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

export const DEFAULT_MAX_RETRY_ATTEMPTS = 5;
export const DEFAULT_RETRY_BASE_DELAY_MS = 250;
export const DEFAULT_RETRY_MAX_DELAY_MS = 10_000;
export const DEFAULT_RETRY_STATUSES = [429, 500, 502, 503, 504] as const;

/** 当跨协议请求转换到 Anthropic 且未提供 max_tokens 时使用的默认值。 */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;
/** Anthropic 扩展思考的 token 预算与最大输出 token 的最小间距。 */
export const MIN_THINKING_HEADROOM_TOKENS = 1024;

export const DEFAULT_CONFIG_CACHE_TTL_MS = 60_000;

export const MAX_WILDCARD_PATTERN_LENGTH = 200;
export const MAX_WILDCARD_SEGMENTS = 16;
export const MAX_ROUTE_DEPTH = 16;

export const HEALTH_CHECK_TIMEOUT_MS = 3_000;

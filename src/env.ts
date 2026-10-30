import type { CoordinationDO } from "./durable-objects/coordination";
import type { RateLimiterDO } from "./durable-objects/rate-limiter";
import type { UsageQueueMessage } from "./usage/events";

/** Worker 绑定与配置。Secrets 通过 wrangler secret / .dev.vars 注入。 */
export interface GatewayEnv {
  DB: D1Database;
  CONFIG_KV: KVNamespace;
  RATE_LIMITER: DurableObjectNamespace<RateLimiterDO>;
  COORDINATION: DurableObjectNamespace<CoordinationDO>;
  USAGE_QUEUE?: Queue<UsageQueueMessage>;
  ARCHIVE_BUCKET?: R2Bucket;

  ENVIRONMENT?: string;
  LOG_LEVEL?: string;
  /** usage：queue（默认）或 direct（测试/无队列环境）。 */
  USAGE_MODE?: string;

  /** 管理员令牌（Secret）。 */
  ADMIN_TOKEN?: string;
  /** 下游 API Key 哈希盐值（Secret）。 */
  API_KEY_PEPPER?: string;
  /** 上游密钥 AES-256-GCM 主密钥，base64 编码 32 字节（Secret）。 */
  ENCRYPTION_KEY?: string;

  /** 仅限本地开发：允许 http/私有地址作为上游。生产环境必须保持未设置。 */
  ALLOW_PRIVATE_UPSTREAMS?: string;
}

export type Env = GatewayEnv;

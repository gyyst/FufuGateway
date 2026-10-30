import { createApp } from "./app";
import { CoordinationDO } from "./durable-objects/coordination";
import { RateLimiterDO } from "./durable-objects/rate-limiter";
import type { GatewayEnv } from "./env";
import { handleScheduled } from "./maintenance";
import { handleUsageBatch } from "./usage/consumer";
import type { UsageQueueMessage } from "./usage/events";

const app = createApp();

export default {
  fetch: async (request: Request, env: GatewayEnv, ctx: ExecutionContext): Promise<Response> =>
    app.fetch(request, env, ctx),
  queue: (batch: MessageBatch<UsageQueueMessage>, env: GatewayEnv, ctx: ExecutionContext): Promise<void> =>
    handleUsageBatch(batch, env, ctx),
  scheduled: (
    controller: ScheduledController,
    env: GatewayEnv,
    ctx: ExecutionContext,
  ): Promise<void> => handleScheduled(controller, env, ctx),
} satisfies ExportedHandler<GatewayEnv, UsageQueueMessage>;

export { CoordinationDO, RateLimiterDO };

import type { GatewayEnv } from "../env";
import { persistUsage } from "./recorder";
import type { UsageQueueMessage } from "./events";

/**
 * 用量队列消费者。至少一次投递下通过 request_id 幂等去重。
 */
export async function handleUsageBatch(
  batch: MessageBatch<UsageQueueMessage>,
  env: GatewayEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await persistUsage(env.DB, message.body);
      message.ack();
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "usage.persist_failed",
          requestId: message.body.requestId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      message.retry();
    }
  }
}

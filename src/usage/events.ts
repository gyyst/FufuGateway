/** 用量队列消息：一次请求的最终统计结果。 */

export interface UsageQueueMessage {
  requestId: string;
  traceId: string;
  userId: string | null;
  apiKeyId: string | null;
  providerId: string | null;
  providerAccountId: string | null;
  requestedModel: string;
  actualModel: string | null;
  comboId: string | null;
  sourceProtocol: string;
  targetProtocol: string | null;
  stream: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  usageSource: "upstream" | "estimated" | "none";
  estimatedCost: number;
  actualCost: number;
  startedAt: number;
  firstTokenAt: number | null;
  finishedAt: number;
  status: "success" | "error" | "cancelled";
  errorCode: string | null;
  httpStatus: number | null;
  retryCount: number;
  routeTrace: unknown;
}

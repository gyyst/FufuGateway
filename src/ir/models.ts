import type { ModelCapabilities } from "./request";

/** 对外暴露的模型目录条目。 */
export interface PublicModel {
  id: string;
  displayName?: string;
  providerId: string;
  providerName: string;
  createdAt?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities: ModelCapabilities;
}

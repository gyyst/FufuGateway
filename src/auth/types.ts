export type UserRole = "admin" | "user";
export type UserStatus = "active" | "disabled";
export type ApiKeyStatus = "active" | "disabled" | "revoked";

export interface UserRecord {
  id: string;
  tenantId: string;
  email?: string;
  displayName?: string;
  role: UserRole;
  status: UserStatus;
  rpmLimit?: number;
  tpmLimit?: number;
  concurrencyLimit?: number;
  dailyBudgetUsd?: number;
  monthlyBudgetUsd?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ApiKeyRecord {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  modelAllowlist?: string[];
  providerAllowlist?: string[];
  rpmLimit?: number;
  tpmLimit?: number;
  concurrencyLimit?: number;
  dailyBudgetUsd?: number;
  monthlyBudgetUsd?: number;
  expiresAt?: number;
  status: ApiKeyStatus;
  rotatedFrom?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface AuthPrincipal {
  type: "admin_token" | "api_key";
  isAdmin: boolean;
  apiKey?: ApiKeyRecord;
  user?: UserRecord;
}

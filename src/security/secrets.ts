import type { GatewayEnv } from "../env";

const SECRET_REF_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export function isValidSecretRef(name: string): boolean {
  return SECRET_REF_PATTERN.test(name);
}

/** 从 Worker Secret 绑定中读取上游密钥。 */
export function readSecretRef(env: GatewayEnv, name: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

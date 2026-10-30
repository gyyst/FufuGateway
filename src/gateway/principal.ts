import type { AuthPrincipal } from "../auth/types";
import type { RouteConstraints } from "../router/resolver";

/** 将 API Key 白名单转换为路由约束。空数组表示不限制。 */
export function constraintsForPrincipal(
  principal: AuthPrincipal | undefined,
): RouteConstraints | undefined {
  const key = principal?.apiKey;
  if (key === undefined) return undefined;
  const allowedModelIds = key.modelAllowlist?.filter((value) => value !== "") ?? [];
  const allowedProviderIds = key.providerAllowlist?.filter((value) => value !== "") ?? [];
  if (allowedModelIds.length === 0 && allowedProviderIds.length === 0) return undefined;
  return {
    ...(allowedModelIds.length === 0 ? {} : { allowedModelIds }),
    ...(allowedProviderIds.length === 0 ? {} : { allowedProviderIds }),
  };
}

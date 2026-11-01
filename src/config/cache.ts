import { DEFAULT_CONFIG_CACHE_TTL_MS } from "../core/limits";
import type { GatewayEnv } from "../env";
import { isPrivateUpstreamAllowed } from "../security/ssrf";
import { CONFIG_CURRENT_KEY, configSnapshotKey } from "./keys";
import { loadConfigData } from "./repository";
import { buildRuntimeConfig, computeChecksum } from "./runtime";
import type { ConfigSnapshot, RuntimeConfig } from "./types";
import { configErrorFromIssues, validateSnapshot } from "./validate";

interface CacheEntry {
  runtime: RuntimeConfig;
  loadedAt: number;
}

let cache: CacheEntry | null = null;

export function clearConfigCache(): void {
  cache = null;
}

type KvLoadResult =
  | { status: "ok"; runtime: RuntimeConfig }
  | { status: "none" }
  | { status: "error" };

async function loadFromKv(env: GatewayEnv): Promise<KvLoadResult> {
  try {
    const pointer = await env.CONFIG_KV.get(CONFIG_CURRENT_KEY);
    if (pointer === null) return { status: "none" };
    const version = Number(pointer);
    if (!Number.isInteger(version) || version <= 0) return { status: "none" };
    const raw = await env.CONFIG_KV.get(configSnapshotKey(version));
    if (raw === null) return { status: "error" };
    const snapshot = JSON.parse(raw) as ConfigSnapshot;
    if (typeof snapshot !== "object" || snapshot === null || typeof snapshot.data !== "object") {
      return { status: "error" };
    }
    const runtime = buildRuntimeConfig(snapshot.data, {
      version: typeof snapshot.version === "number" ? snapshot.version : version,
      checksum: typeof snapshot.checksum === "string" ? snapshot.checksum : "",
      createdAt: typeof snapshot.createdAt === "number" ? snapshot.createdAt : Date.now(),
      source: "kv",
    });
    return { status: "ok", runtime };
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "config.kv_load_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { status: "error" };
  }
}

async function buildFallbackRuntime(env: GatewayEnv): Promise<RuntimeConfig> {
  const data = await loadConfigData(env.DB);
  const issues = validateSnapshot(data, {
    allowPrivateUpstreams: isPrivateUpstreamAllowed(env),
  });
  if (issues.some((entry) => entry.severity === "error")) {
    throw configErrorFromIssues(issues);
  }
  const checksum = await computeChecksum(data);
  return buildRuntimeConfig(data, {
    version: 0,
    checksum,
    createdAt: Date.now(),
    source: "d1-fallback",
  });
}

/**
 * 读取运行期配置。
 *
 * 优先使用 KV 中已发布的版本快照；没有生效版本时回退到 D1 当前数据
 * （内存缓存，最长 60 秒），便于首次启动与本地开发。KV 故障时保持
 * 最后一次可用配置，避免流量切换到尚未生效的 D1 数据。
 */
export async function loadRuntimeConfig(
  env: GatewayEnv,
  options: { force?: boolean } = {},
): Promise<RuntimeConfig> {
  const timestamp = Date.now();
  const ttl = cache?.runtime.settings.configCacheTtlMs ?? DEFAULT_CONFIG_CACHE_TTL_MS;
  if (options.force !== true && cache !== null && timestamp - cache.loadedAt < ttl) {
    return cache.runtime;
  }

  const kvResult = await loadFromKv(env);
  if (kvResult.status === "ok") {
    cache = { runtime: kvResult.runtime, loadedAt: timestamp };
    return kvResult.runtime;
  }
  if (kvResult.status === "error" && cache !== null) {
    cache.loadedAt = timestamp;
    return cache.runtime;
  }

  const fallback = await buildFallbackRuntime(env);
  cache = { runtime: fallback, loadedAt: timestamp };
  return fallback;
}

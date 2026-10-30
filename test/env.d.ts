import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { GatewayEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends GatewayEnv {
      TEST_MIGRATIONS: D1Migration[];
    }

    interface GlobalProps {
      mainModule: typeof import("../src/index");
      durableNamespaces: "RateLimiterDO" | "CoordinationDO";
    }
  }
}

export {};

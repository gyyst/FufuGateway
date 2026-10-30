import type { Context } from "hono";
import type { AppEnv } from "../../app";
import { loadRuntimeConfig } from "../../config/cache";

interface BreakerView {
  id: string;
  name: string;
  state: string;
  consecutiveFailures: number;
  windowFailures: number;
  windowTotal: number;
}

/** 管理端：读取当前生效配置中各 Provider / Account / Model 的熔断状态。 */
export async function breakerHealthHandler(c: Context<AppEnv>): Promise<Response> {
  const config = await loadRuntimeConfig(c.env, { force: true });
  const providers: Array<{
    providerId: string;
    providerName: string;
    providerState: BreakerView;
    accounts: BreakerView[];
    models: BreakerView[];
  }> = [];

  for (const provider of config.data.providers.slice(0, 100)) {
    const stub = c.env.COORDINATION.get(
      c.env.COORDINATION.idFromName(`breaker:${provider.id}`),
    );
    const accounts = await Promise.all(
      (config.accountsByProvider.get(provider.id) ?? []).map(async (account) => {
        const state = await stub.breakerState(`account:${account.id}`);
        return {
          id: account.id,
          name: account.name,
          state: state.state,
          consecutiveFailures: state.consecutiveFailures,
          windowFailures: state.windowFailures,
          windowTotal: state.windowTotal,
        };
      }),
    );
    const models = await Promise.all(
      (config.modelsByProvider.get(provider.id) ?? []).slice(0, 200).map(async (model) => {
        const state = await stub.breakerState(`model:${model.id}`);
        return {
          id: model.id,
          name: model.modelId,
          state: state.state,
          consecutiveFailures: state.consecutiveFailures,
          windowFailures: state.windowFailures,
          windowTotal: state.windowTotal,
        };
      }),
    );
    const providerState = await stub.breakerState(`provider:${provider.id}`);
    providers.push({
      providerId: provider.id,
      providerName: provider.name,
      providerState: {
        id: provider.id,
        name: provider.name,
        state: providerState.state,
        consecutiveFailures: providerState.consecutiveFailures,
        windowFailures: providerState.windowFailures,
        windowTotal: providerState.windowTotal,
      },
      accounts,
      models,
    });
  }

  return c.json({ data: providers });
}

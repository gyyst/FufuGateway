import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { DEFAULT_BREAKER_OPTIONS } from "../../src/execution/breaker";
import { sleep } from "../../src/core/time";

const options = {
  ...DEFAULT_BREAKER_OPTIONS,
  failureThreshold: 2,
  minSamples: 100,
  openMs: 500,
  halfOpenProbes: 1,
};

describe("熔断器状态机", () => {
  it("连续失败打开熔断，冷却后半开并恢复", async () => {
    const stub = env.COORDINATION.get(env.COORDINATION.idFromName("breaker:unit-provider"));
    const key = "model:unit-model";

    expect(await stub.breakerAllow(key, options)).toBe(true);
    await stub.breakerRecord(key, false, options);
    expect(await stub.breakerAllow(key, options)).toBe(true);
    await stub.breakerRecord(key, false, options);

    let state = await stub.breakerState(key);
    expect(state.state).toBe("open");
    expect(await stub.breakerAllow(key, options)).toBe(false);

    await sleep(600);
    expect(await stub.breakerAllow(key, options)).toBe(true);
    state = await stub.breakerState(key);
    expect(state.state).toBe("half_open");
    expect(await stub.breakerAllow(key, options)).toBe(false);

    await stub.breakerRecord(key, true, options);
    state = await stub.breakerState(key);
    expect(state.state).toBe("closed");
    expect(await stub.breakerAllow(key, options)).toBe(true);
  });

  it("半开探测失败会重新打开", async () => {
    const stub = env.COORDINATION.get(env.COORDINATION.idFromName("breaker:unit-provider-2"));
    const key = "model:unit-model-2";
    await stub.breakerRecord(key, false, options);
    await stub.breakerRecord(key, false, options);
    expect((await stub.breakerState(key)).state).toBe("open");

    await sleep(600);
    expect(await stub.breakerAllow(key, options)).toBe(true);
    await stub.breakerRecord(key, false, options);
    expect((await stub.breakerState(key)).state).toBe("open");
    expect(await stub.breakerAllow(key, options)).toBe(false);
  });
});

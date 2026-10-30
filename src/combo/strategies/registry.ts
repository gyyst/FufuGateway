import { GatewayError } from "../../core/errors";
import type { StrategyId } from "../types";
import type { ComboStrategy } from "./types";
import { fallbackStrategy } from "./fallback";
import { priorityStrategy } from "./priority";
import { roundRobinStrategy } from "./round-robin";
import { weightedRoundRobinStrategy } from "./weighted-round-robin";
import { randomStrategy } from "./random";
import { lowestLatencyStrategy } from "./lowest-latency";
import { lowestCostStrategy } from "./lowest-cost";
import { raceStrategy } from "./race";
import { fusionStrategy } from "./fusion";

const STRATEGIES: Record<StrategyId, ComboStrategy> = {
  fallback: fallbackStrategy,
  priority: priorityStrategy,
  round_robin: roundRobinStrategy,
  weighted_round_robin: weightedRoundRobinStrategy,
  random: randomStrategy,
  lowest_latency: lowestLatencyStrategy,
  lowest_cost: lowestCostStrategy,
  race: raceStrategy,
  fusion: fusionStrategy,
};

export function getComboStrategy(id: StrategyId): ComboStrategy {
  const strategy = STRATEGIES[id];
  if (strategy === undefined) {
    throw new GatewayError({
      code: "COMBO_EXECUTION_FAILED",
      message: `Unknown combo strategy "${id}"`,
    });
  }
  return strategy;
}

export function listComboStrategies(): ComboStrategy[] {
  return Object.values(STRATEGIES);
}

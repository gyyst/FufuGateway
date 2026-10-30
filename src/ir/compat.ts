import { GatewayError } from "../core/errors";
import type { ProtocolId } from "./common";

/** 参数兼容策略。 */
export type CompatibilityPolicy = "strict" | "warn" | "drop" | "passthrough";

export type CompatibilityAction = "emulated" | "dropped" | "error" | "passthrough" | "defaulted";

export interface CompatibilityIssue {
  feature: string;
  source: ProtocolId | "gateway";
  target: ProtocolId | "gateway";
  action: CompatibilityAction;
  message: string;
}

export interface CompatibilityContext {
  policy: CompatibilityPolicy;
  source: ProtocolId | "gateway";
  target: ProtocolId | "gateway";
  issues: CompatibilityIssue[];
}

export function createCompatibilityContext(
  policy: CompatibilityPolicy,
  source: ProtocolId | "gateway",
  target: ProtocolId | "gateway",
): CompatibilityContext {
  return { policy, source, target, issues: [] };
}

/**
 * 报告目标协议无法表达的能力。
 * strict 策略直接报错；其余策略记录丢弃，绝不静默。
 */
export function reportUnsupported(
  ctx: CompatibilityContext,
  feature: string,
  message: string,
): void {
  if (ctx.policy === "strict") {
    ctx.issues.push({
      feature,
      source: ctx.source,
      target: ctx.target,
      action: "error",
      message,
    });
    throw new GatewayError({
      code: "UNSUPPORTED_FEATURE",
      message: `Feature "${feature}" is not supported when converting to ${ctx.target}: ${message}`,
      details: { feature, source: ctx.source, target: ctx.target },
    });
  }
  ctx.issues.push({
    feature,
    source: ctx.source,
    target: ctx.target,
    action: "dropped",
    message,
  });
}

/** 记录通过近似方式实现的能力（例如 effort → budget tokens）。 */
export function reportEmulated(
  ctx: CompatibilityContext,
  feature: string,
  message: string,
): void {
  ctx.issues.push({
    feature,
    source: ctx.source,
    target: ctx.target,
    action: "emulated",
    message,
  });
}

/** 记录使用了网关默认值。 */
export function reportDefaulted(
  ctx: CompatibilityContext,
  feature: string,
  message: string,
): void {
  ctx.issues.push({
    feature,
    source: ctx.source,
    target: ctx.target,
    action: "defaulted",
    message,
  });
}

export function reportPassthrough(
  ctx: CompatibilityContext,
  feature: string,
  message: string,
): void {
  ctx.issues.push({
    feature,
    source: ctx.source,
    target: ctx.target,
    action: "passthrough",
    message,
  });
}

/** 仅允许在源协议与目标协议一致时透传扩展参数。 */
export function canPassthrough(ctx: CompatibilityContext): boolean {
  return ctx.policy === "passthrough" && ctx.source === ctx.target;
}

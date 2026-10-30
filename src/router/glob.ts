import { GatewayError } from "../core/errors";

const MAX_PATTERN_LENGTH = 200;
const MAX_SEGMENTS = 16;
const MAX_WILDCARDS = 8;
const ALLOWED_PATTERN = /^[A-Za-z0-9._:/@+*?-]+$/;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

export interface CompiledGlob {
  pattern: string;
  regex: RegExp;
  literalChars: number;
  wildcards: number;
  segments: number;
}

/** 仅支持 * 与 ? 的安全 Glob；其余字符一律按字面量转义。 */
export function compileGlob(pattern: string): CompiledGlob {
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) {
    throw new GatewayError({
      code: "CONFIG_INVALID",
      message: `Wildcard pattern must be 1-${MAX_PATTERN_LENGTH} characters`,
    });
  }
  if (!ALLOWED_PATTERN.test(pattern)) {
    throw new GatewayError({
      code: "CONFIG_INVALID",
      message: `Wildcard pattern "${pattern}" contains unsupported characters`,
    });
  }
  const segments = pattern.split("/").length;
  if (segments > MAX_SEGMENTS) {
    throw new GatewayError({
      code: "CONFIG_INVALID",
      message: `Wildcard pattern must have at most ${MAX_SEGMENTS} segments`,
    });
  }
  let wildcards = 0;
  let literalChars = 0;
  let source = "";
  for (const char of pattern) {
    if (char === "*") {
      wildcards += 1;
      source += "[\\s\\S]*";
    } else if (char === "?") {
      wildcards += 1;
      source += "[\\s\\S]";
    } else {
      literalChars += 1;
      source += char.replace(REGEX_SPECIAL, "\\$&");
    }
  }
  if (wildcards === 0) {
    throw new GatewayError({
      code: "CONFIG_INVALID",
      message: `Wildcard pattern "${pattern}" must contain at least one wildcard`,
    });
  }
  if (wildcards > MAX_WILDCARDS) {
    throw new GatewayError({
      code: "CONFIG_INVALID",
      message: `Wildcard pattern must contain at most ${MAX_WILDCARDS} wildcards`,
    });
  }
  return {
    pattern,
    regex: new RegExp(`^${source}$`),
    literalChars,
    wildcards,
    segments,
  };
}

export function globMatches(compiled: CompiledGlob, modelId: string): boolean {
  return compiled.regex.test(modelId);
}

/**
 * 通配符具体度比较：字面量更多、通配符更少、段数更多者更具体。
 * 返回负数表示 a 比 b 更具体。
 */
export function compareGlobSpecificity(a: CompiledGlob, b: CompiledGlob): number {
  if (a.literalChars !== b.literalChars) return b.literalChars - a.literalChars;
  if (a.wildcards !== b.wildcards) return a.wildcards - b.wildcards;
  if (a.segments !== b.segments) return b.segments - a.segments;
  return a.pattern.localeCompare(b.pattern);
}

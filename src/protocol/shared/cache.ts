import type { UnifiedContentPart, UnifiedRequest } from "../../ir";

function partsUseCache(parts: readonly UnifiedContentPart[]): boolean {
  for (const part of parts) {
    if ((part.type === "text" || part.type === "image") && part.cacheControl !== undefined) {
      return true;
    }
    if (part.type === "tool_result" && partsUseCache(part.content)) return true;
  }
  return false;
}

/** 请求是否包含 Anthropic 风格的显式 prompt cache 控制。 */
export function requestUsesCacheControl(request: UnifiedRequest): boolean {
  if (request.system.some((instruction) => partsUseCache(instruction.content))) return true;
  if (request.messages.some((message) => partsUseCache(message.content))) return true;
  return request.tools.some((tool) => tool.cacheControl !== undefined);
}

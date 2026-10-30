import { GatewayError } from "../../core/errors";
import { asString, getRecord, isRecord, type JsonObject } from "../../core/json";
import {
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  MIN_THINKING_HEADROOM_TOKENS,
} from "../../core/limits";
import type {
  UnifiedContentPart,
  UnifiedMessage,
  UnifiedReasoningConfig,
  UnifiedRequest,
  UnifiedSystemInstruction,
  UnifiedTool,
  UnifiedToolChoice,
} from "../../ir";
import { finalizeRequest } from "../../ir";
import {
  createCompatibilityContext,
  reportDefaulted,
  reportEmulated,
  reportUnsupported,
  type CompatibilityContext,
} from "../../ir/compat";
import { cloneJsonObject, pickExtensions } from "../shared/http";
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  parseCacheControl,
  parseToolArguments,
  requireArray,
  requireObject,
  requireString,
  serializeCacheControl,
} from "../shared/validate";
import type { BuildRequestContext, ParseRequestContext } from "../types";

const KNOWN_KEYS = [
  "model",
  "messages",
  "system",
  "max_tokens",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "stream",
  "tools",
  "tool_choice",
  "metadata",
  "thinking",
] as const;

function unsupported(feature: string, message: string): never {
  throw new GatewayError({
    code: "UNSUPPORTED_FEATURE",
    message: `${feature}: ${message}`,
    details: { feature },
  });
}

function parseImageBlock(block: JsonObject, path: string): UnifiedContentPart {
  const source = requireObject(block["source"], `${path}.source`);
  const type = requireString(source["type"], `${path}.source.type`);
  if (type === "base64") {
    return {
      type: "image",
      source: {
        kind: "base64",
        mediaType: requireString(source["media_type"], `${path}.source.media_type`),
        data: requireString(source["data"], `${path}.source.data`),
      },
    };
  }
  if (type === "url") {
    return {
      type: "image",
      source: { kind: "url", url: requireString(source["url"], `${path}.source.url`) },
    };
  }
  if (type === "file") {
    const mediaType = optionalString(source["media_type"], `${path}.source.media_type`);
    const image: UnifiedContentPart = {
      type: "image",
      source: {
        kind: "file",
        fileId: requireString(source["file_id"], `${path}.source.file_id`),
      },
    };
    if (mediaType !== undefined) {
      if (image.source.kind === "file") image.source.mediaType = mediaType;
    }
    return image;
  }
  unsupported(`image.source.${type}`, "unsupported Anthropic image source type");
}

function parseAnthropicBlocks(
  raw: unknown,
  path: string,
  mode: "message" | "tool_result",
): UnifiedContentPart[] {
  if (typeof raw === "string") {
    return raw === "" ? [] : [{ type: "text", text: raw }];
  }
  if (raw === undefined || raw === null) return [];
  const blocks = requireArray(raw, path);
  const result: UnifiedContentPart[] = [];
  blocks.forEach((entry, index) => {
    const block = requireObject(entry, `${path}[${index}]`);
    const type = requireString(block["type"], `${path}[${index}].type`);
    switch (type) {
      case "text": {
        const text = asString(block["text"]);
        if (text === undefined) {
          throw new GatewayError({ code: "INVALID_REQUEST", message: `${path}[${index}].text must be a string` });
        }
        const part: UnifiedContentPart = { type: "text", text };
        const cacheControl = parseCacheControl(block["cache_control"]);
        if (cacheControl !== undefined) part.cacheControl = cacheControl;
        result.push(part);
        break;
      }
      case "image":
        result.push(parseImageBlock(block, `${path}[${index}]`));
        break;
      case "tool_use": {
        if (mode !== "message") {
          unsupported("tool_result.tool_use", "tool_use blocks are not valid inside tool results");
        }
        const id = requireString(block["id"], `${path}[${index}].id`);
        const name = requireString(block["name"], `${path}[${index}].name`);
        const parsed = parseToolArguments(block["input"]);
        const part: UnifiedContentPart = {
          type: "tool_call",
          id,
          name,
          arguments: parsed.arguments,
        };
        if (parsed.rawArguments !== undefined) part.rawArguments = parsed.rawArguments;
        result.push(part);
        break;
      }
      case "tool_result": {
        if (mode !== "message") {
          unsupported("tool_result.nested", "nested tool_result blocks are not supported");
        }
        const part: UnifiedContentPart = {
          type: "tool_result",
          toolCallId: requireString(block["tool_use_id"], `${path}[${index}].tool_use_id`),
          content: parseAnthropicBlocks(block["content"], `${path}[${index}].content`, "tool_result"),
        };
        const isError = optionalBoolean(block["is_error"], `${path}[${index}].is_error`);
        if (isError !== undefined) part.isError = isError;
        result.push(part);
        break;
      }
      case "thinking": {
        if (mode !== "message") {
          unsupported("tool_result.thinking", "thinking blocks are not valid inside tool results");
        }
        const part: UnifiedContentPart = {
          type: "thinking",
          text: asString(block["thinking"]) ?? "",
        };
        const signature = optionalString(block["signature"], `${path}[${index}].signature`);
        if (signature !== undefined) part.signature = signature;
        result.push(part);
        break;
      }
      case "redacted_thinking": {
        if (mode !== "message") {
          unsupported("tool_result.redacted_thinking", "redacted thinking is not valid inside tool results");
        }
        result.push({
          type: "thinking",
          text: "",
          redacted: true,
          redactedData: asString(block["data"]) ?? "",
        });
        break;
      }
      case "document":
        unsupported("content.document", "document blocks are not supported in this version");
        break;
      default:
        unsupported(`content.${type}`, `unsupported Anthropic content block type "${type}"`);
    }
  });
  return result;
}

function parseSystem(raw: unknown): UnifiedSystemInstruction[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") {
    return raw === "" ? [] : [{ role: "system", content: [{ type: "text", text: raw }] }];
  }
  return [{ role: "system", content: parseAnthropicBlocks(raw, "system", "message") }];
}

function parseMessages(raw: unknown): UnifiedMessage[] {
  const messagesRaw = requireArray(raw, "messages");
  if (messagesRaw.length === 0) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "messages must not be empty" });
  }
  return messagesRaw.map((entry, index) => {
    const message = requireObject(entry, `messages[${index}]`);
    const role = requireString(message["role"], `messages[${index}].role`);
    if (role !== "user" && role !== "assistant") {
      throw new GatewayError({
        code: "INVALID_REQUEST",
        message: `messages[${index}].role must be "user" or "assistant"`,
      });
    }
    return {
      role,
      content: parseAnthropicBlocks(message["content"], `messages[${index}].content`, "message"),
    };
  });
}

function parseTools(raw: unknown): UnifiedTool[] {
  if (raw === undefined || raw === null) return [];
  const list = requireArray(raw, "tools");
  return list.map((entry, index) => {
    const tool = requireObject(entry, `tools[${index}]`);
    const type = optionalString(tool["type"], `tools[${index}].type`);
    if (type !== undefined && type !== "custom") {
      unsupported(`tools.${type}`, "only custom tools can be routed by the gateway");
    }
    const name = requireString(tool["name"], `tools[${index}].name`);
    const description = optionalString(tool["description"], `tools[${index}].description`);
    const schema = tool["input_schema"];
    if (schema !== undefined && !isRecord(schema)) {
      throw new GatewayError({ code: "INVALID_REQUEST", message: `tools[${index}].input_schema must be an object` });
    }
    const toolResult: UnifiedTool = {
      name,
      inputSchema: isRecord(schema) ? schema : { type: "object", properties: {} },
    };
    if (description !== undefined) toolResult.description = description;
    const cacheControl = parseCacheControl(tool["cache_control"]);
    if (cacheControl !== undefined) toolResult.cacheControl = cacheControl;
    return toolResult;
  });
}

interface ParsedAnthropicToolChoice {
  choice: UnifiedToolChoice;
  parallelToolCalls?: boolean;
}

function parseToolChoice(raw: unknown): ParsedAnthropicToolChoice {
  if (raw === undefined || raw === null) return { choice: { type: "auto" } };
  const choice = requireObject(raw, "tool_choice");
  const type = requireString(choice["type"], "tool_choice.type");
  const disableParallel = optionalBoolean(
    choice["disable_parallel_tool_use"],
    "tool_choice.disable_parallel_tool_use",
  );
  const result: ParsedAnthropicToolChoice = { choice: { type: "auto" } };
  if (disableParallel !== undefined) result.parallelToolCalls = !disableParallel;

  if (type === "auto") result.choice = { type: "auto" };
  else if (type === "none") result.choice = { type: "none" };
  else if (type === "any") result.choice = { type: "required" };
  else if (type === "tool") {
    result.choice = {
      type: "tool",
      name: requireString(choice["name"], "tool_choice.name"),
    };
  } else {
    throw new GatewayError({ code: "INVALID_REQUEST", message: `unsupported tool_choice.type "${type}"` });
  }
  return result;
}

function parseReasoning(body: JsonObject): UnifiedReasoningConfig | undefined {
  const raw = getRecord(body, "thinking");
  if (!raw) return undefined;
  const type = requireString(raw["type"], "thinking.type");
  if (type === "disabled") return undefined;
  if (type !== "enabled") {
    throw new GatewayError({ code: "INVALID_REQUEST", message: `unsupported thinking.type "${type}"` });
  }
  const budget = optionalNumber(raw["budget_tokens"], "thinking.budget_tokens", { min: 1 });
  if (budget === undefined) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "thinking.budget_tokens is required when thinking is enabled" });
  }
  return { budgetTokens: budget, includeInOutput: true };
}

export function parseAnthropicRequest(body: JsonObject, _ctx?: ParseRequestContext): UnifiedRequest {
  const model = requireString(body["model"], "model");
  const maxTokens = optionalNumber(body["max_tokens"], "max_tokens", { min: 1 });
  if (maxTokens === undefined) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "max_tokens is required" });
  }

  const messages = parseMessages(body["messages"]);
  const tools = parseTools(body["tools"]);
  const { choice, parallelToolCalls } = parseToolChoice(body["tool_choice"]);
  const metadataRecord = getRecord(body, "metadata");

  return finalizeRequest({
    sourceProtocol: "anthropic",
    sourceBody: body,
    model,
    system: parseSystem(body["system"]),
    messages,
    tools,
    toolChoice: choice,
    parallelToolCalls,
    maxOutputTokens: maxTokens,
    temperature: optionalNumber(body["temperature"], "temperature", { min: 0, max: 1 }),
    topP: optionalNumber(body["top_p"], "top_p", { min: 0, max: 1 }),
    topK: optionalNumber(body["top_k"], "top_k", { min: 0 }),
    stopSequences:
      body["stop_sequences"] === undefined
        ? []
        : requireArray(body["stop_sequences"], "stop_sequences").map((value, index) =>
            requireString(value, `stop_sequences[${index}]`),
          ),
    stream: optionalBoolean(body["stream"], "stream") ?? false,
    reasoning: parseReasoning(body),
    metadata: {
      ...(metadataRecord && asString(metadataRecord["user_id"]) !== undefined
        ? { userId: asString(metadataRecord["user_id"]) }
        : {}),
    },
    extensions: { source: "anthropic", values: pickExtensions(body, KNOWN_KEYS) },
    raw: { protocol: "anthropic", body },
  });
}

// ---------------------------------------------------------------------------
// IR → Anthropic 上游请求
// ---------------------------------------------------------------------------

const EFFORT_TO_THINKING_BUDGET: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
};

function renderCacheControl(part: { cacheControl?: { type: "ephemeral" | "persistent"; ttl?: string } }): JsonObject {
  const serialized = serializeCacheControl(part.cacheControl);
  return serialized === undefined ? {} : { cache_control: serialized };
}

function renderImageBlock(part: UnifiedContentPart & { type: "image" }, compat: CompatibilityContext): JsonObject | undefined {
  if (part.source.kind === "base64") {
    return {
      type: "image",
      source: { type: "base64", media_type: part.source.mediaType, data: part.source.data },
    };
  }
  if (part.source.kind === "url") {
    return { type: "image", source: { type: "url", url: part.source.url } };
  }
  if (part.source.kind === "file") {
    return {
      type: "image",
      source: {
        type: "file",
        file_id: part.source.fileId,
        ...(part.source.mediaType === undefined ? {} : { media_type: part.source.mediaType }),
      },
    };
  }
  reportUnsupported(compat, "image.source", "unsupported image source");
  return undefined;
}

function renderToolResultBlock(
  part: UnifiedContentPart & { type: "tool_result" },
  compat: CompatibilityContext,
): JsonObject {
  const blocks: JsonObject[] = [];
  for (const item of part.content) {
    if (item.type === "text") {
      blocks.push({ type: "text", text: item.text });
    } else if (item.type === "image") {
      const rendered = renderImageBlock(item, compat);
      if (rendered) blocks.push(rendered);
    } else {
      reportUnsupported(compat, `tool_result.${item.type}`, "unsupported block inside tool result");
    }
  }
  if (blocks.length === 0 && part.structured !== undefined) {
    blocks.push({ type: "text", text: JSON.stringify(part.structured) });
    reportEmulated(compat, "tool_result.structured", "structured tool result was serialized as JSON text");
  }
  const content: string | JsonObject[] = blocks.length === 1 && blocks[0]?.["type"] === "text"
    ? String(blocks[0]["text"] ?? "")
    : blocks;
  return {
    type: "tool_result",
    tool_use_id: part.toolCallId,
    content,
    ...(part.isError === true ? { is_error: true } : {}),
  };
}

function renderContentBlocks(
  parts: readonly UnifiedContentPart[],
  role: "user" | "assistant",
  compat: CompatibilityContext,
): JsonObject[] {
  const blocks: JsonObject[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "text":
        blocks.push({ type: "text", text: part.text, ...renderCacheControl(part) });
        break;
      case "image": {
        if (role !== "user") {
          reportUnsupported(compat, "assistant.image", "assistant messages cannot contain images");
          break;
        }
        const rendered = renderImageBlock(part, compat);
        if (rendered) blocks.push({ ...rendered, ...renderCacheControl(part) });
        break;
      }
      case "tool_call":
        blocks.push({
          type: "tool_use",
          id: part.id,
          name: part.name,
          input: part.arguments,
        });
        break;
      case "tool_result":
        if (role !== "user") {
          reportUnsupported(compat, "assistant.tool_result", "tool results must appear in user messages");
          break;
        }
        blocks.push(renderToolResultBlock(part, compat));
        break;
      case "thinking":
        if (role !== "assistant") {
          reportUnsupported(compat, "user.thinking", "thinking blocks are only valid in assistant messages");
          break;
        }
        if (part.redacted === true) {
          blocks.push({ type: "redacted_thinking", data: part.redactedData ?? part.signature ?? "" });
        } else if (part.signature !== undefined) {
          blocks.push({ type: "thinking", thinking: part.text, signature: part.signature });
        } else {
          reportUnsupported(
            compat,
            "thinking.signature",
            "Anthropic requires a signature for thinking blocks; unsigned reasoning was dropped",
          );
        }
        break;
      case "refusal":
        blocks.push({ type: "text", text: part.text });
        reportEmulated(compat, "refusal", "refusal was converted to a text block");
        break;
    }
  }
  return blocks;
}

function resolveThinkingBudget(request: UnifiedRequest, compat: CompatibilityContext): number | undefined {
  const reasoning = request.reasoning;
  if (!reasoning) return undefined;
  if (reasoning.budgetTokens !== undefined) return reasoning.budgetTokens;
  if (reasoning.effort !== undefined) {
    const budget = EFFORT_TO_THINKING_BUDGET[reasoning.effort];
    if (budget !== undefined) {
      reportEmulated(
        compat,
        "reasoning.effort",
        `reasoning effort "${reasoning.effort}" was mapped to a ${budget} token thinking budget`,
      );
      return budget;
    }
  }
  return undefined;
}

export function buildAnthropicRequest(request: UnifiedRequest, ctx: BuildRequestContext): JsonObject {
  if (request.raw.protocol === "anthropic" && ctx.policy === "passthrough") {
    const passthrough = cloneJsonObject(request.raw.body);
    passthrough["model"] = ctx.upstreamModel;
    return passthrough;
  }

  const compat = createCompatibilityContext(ctx.policy, request.raw.protocol, "anthropic");
  const thinkingBudget = resolveThinkingBudget(request, compat);

  if (ctx.capabilities && request.tools.length > 0 && !ctx.capabilities.supportsTools) {
    reportUnsupported(compat, "tools", "target model does not support tools");
  }

  const body: JsonObject = { model: ctx.upstreamModel };

  if (request.system.length > 0) {
    const systemBlocks: JsonObject[] = [];
    for (const instruction of request.system) {
      for (const part of instruction.content) {
        if (part.type === "text") {
          systemBlocks.push({ type: "text", text: part.text, ...renderCacheControl(part) });
        } else {
          reportUnsupported(compat, `system.${part.type}`, "Anthropic system prompts only support text blocks");
        }
      }
    }
    if (systemBlocks.length > 0) {
      const first = systemBlocks[0];
      if (systemBlocks.length === 1 && first !== undefined && first["cache_control"] === undefined) {
        body["system"] = String(first["text"] ?? "");
      } else {
        body["system"] = systemBlocks;
      }
    }
  }

  const messages: JsonObject[] = [];
  const pushMessage = (role: "user" | "assistant", blocks: JsonObject[]): void => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    if (last !== undefined && last["role"] === role) {
      const existing = last["content"];
      if (Array.isArray(existing)) existing.push(...blocks);
      else last["content"] = [...(typeof existing === "string" ? [{ type: "text", text: existing }] : []), ...blocks];
      return;
    }
    messages.push({ role, content: blocks });
  };

  for (const message of request.messages) {
    if (message.role === "tool") {
      const blocks: JsonObject[] = [];
      for (const part of message.content) {
        if (part.type === "tool_result") blocks.push(renderToolResultBlock(part, compat));
        else reportUnsupported(compat, `tool.${part.type}`, "tool messages may only contain tool results");
      }
      pushMessage("user", blocks);
      continue;
    }
    pushMessage(message.role, renderContentBlocks(message.content, message.role, compat));
  }

  if (messages.length === 0) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "Anthropic requires at least one message" });
  }
  body["messages"] = messages;

  let maxTokens = request.maxOutputTokens;
  if (maxTokens === undefined) {
    maxTokens = DEFAULT_ANTHROPIC_MAX_TOKENS;
    reportDefaulted(compat, "max_tokens", `max_tokens was defaulted to ${DEFAULT_ANTHROPIC_MAX_TOKENS}`);
  }
  if (thinkingBudget !== undefined && maxTokens <= thinkingBudget) {
    maxTokens = thinkingBudget + MIN_THINKING_HEADROOM_TOKENS;
    reportEmulated(
      compat,
      "max_tokens",
      `max_tokens was raised to ${maxTokens} to exceed the thinking budget`,
    );
  }
  body["max_tokens"] = maxTokens;

  if (thinkingBudget !== undefined) {
    body["thinking"] = { type: "enabled", budget_tokens: thinkingBudget };
    if (request.temperature !== undefined || request.topP !== undefined || request.topK !== undefined) {
      reportEmulated(
        compat,
        "thinking.sampling",
        "extended thinking requires default sampling settings; temperature/top_p/top_k were omitted",
      );
    }
    if (request.toolChoice.type === "required" || request.toolChoice.type === "tool") {
      reportEmulated(
        compat,
        "thinking.tool_choice",
        "extended thinking is incompatible with forced tool use; tool_choice was relaxed to auto",
      );
    }
  } else {
    if (request.temperature !== undefined) {
      if (request.temperature > 1) {
        reportEmulated(compat, "temperature", "Anthropic temperature must be <= 1; value was clamped");
        body["temperature"] = 1;
      } else {
        body["temperature"] = request.temperature;
      }
    }
    if (request.topP !== undefined) body["top_p"] = request.topP;
    if (request.topK !== undefined) body["top_k"] = request.topK;
  }

  if (request.stopSequences.length > 0) body["stop_sequences"] = request.stopSequences;
  body["stream"] = request.stream;

  if (request.tools.length > 0) {
    body["tools"] = request.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      input_schema: tool.inputSchema,
      ...renderCacheControl(tool),
    }));
    const choice = request.toolChoice;
    const disableParallel =
      request.parallelToolCalls === undefined ? undefined : !request.parallelToolCalls;
    if (choice.type === "auto") {
      body["tool_choice"] = {
        type: "auto",
        ...(disableParallel === true ? { disable_parallel_tool_use: true } : {}),
      };
    } else if (choice.type === "none") {
      body["tool_choice"] = { type: "none" };
    } else if (choice.type === "required") {
      body["tool_choice"] = {
        ...(thinkingBudget !== undefined ? { type: "auto" } : { type: "any" }),
        ...(disableParallel === true ? { disable_parallel_tool_use: true } : {}),
      };
    } else {
      body["tool_choice"] = {
        ...(thinkingBudget !== undefined ? { type: "auto" } : { type: "tool", name: choice.name }),
        ...(disableParallel === true ? { disable_parallel_tool_use: true } : {}),
      };
    }
  }

  if (request.metadata.promptCacheKey !== undefined) {
    reportUnsupported(compat, "prompt_cache_key", "Anthropic has no prompt_cache_key parameter");
  }

  if (request.responseFormat !== undefined && request.responseFormat.type !== "text") {
    reportUnsupported(
      compat,
      "response_format",
      "Anthropic Messages has no equivalent structured output parameter in this gateway version",
    );
  }
  if (request.frequencyPenalty !== undefined) {
    reportUnsupported(compat, "frequency_penalty", "Anthropic has no frequency penalty");
  }
  if (request.presencePenalty !== undefined) {
    reportUnsupported(compat, "presence_penalty", "Anthropic has no presence penalty");
  }
  if (request.seed !== undefined) {
    reportUnsupported(compat, "seed", "Anthropic has no seed parameter");
  }

  const extensionKeys = Object.keys(request.extensions.values);
  if (extensionKeys.length > 0) {
    reportUnsupported(
      compat,
      "extensions",
      `unmapped parameters were dropped: ${extensionKeys.join(", ")}`,
    );
  }

  ctx.issues.push(...compat.issues);
  return body;
}

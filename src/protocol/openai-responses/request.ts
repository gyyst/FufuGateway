import { GatewayError } from "../../core/errors";
import { asString, getRecord, isRecord, type JsonObject } from "../../core/json";
import type {
  UnifiedContentPart,
  UnifiedMessage,
  UnifiedRequest,
  UnifiedResponseFormat,
  UnifiedSystemInstruction,
  UnifiedTool,
  UnifiedToolChoice,
} from "../../ir";
import { finalizeRequest } from "../../ir";
import {
  createCompatibilityContext,
  reportEmulated,
  reportUnsupported,
} from "../../ir/compat";
import { cloneJsonObject, imageSourceFromUrl, imageSourceToUrl, pickExtensions } from "../shared/http";
import { requestUsesCacheControl } from "../shared/cache";
import {
  isHttpUrl,
  optionalBoolean,
  optionalNumber,
  optionalString,
  parseToolArguments,
  requireArray,
  requireObject,
  requireString,
  stringifyToolArguments,
  syntheticToolCallId,
} from "../shared/validate";
import type { BuildRequestContext, ParseRequestContext } from "../types";

const KNOWN_KEYS = [
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "max_output_tokens",
  "temperature",
  "top_p",
  "text",
  "reasoning",
  "stream",
  "metadata",
  "user",
  "store",
] as const;

const EFFORTS = new Set(["minimal", "low", "medium", "high"]);

function unsupported(feature: string, message: string): never {
  throw new GatewayError({
    code: "UNSUPPORTED_FEATURE",
    message: `${feature}: ${message}`,
    details: { feature },
  });
}

function parseResponsesContent(raw: unknown, path: string): UnifiedContentPart[] {
  if (typeof raw === "string") {
    return raw === "" ? [] : [{ type: "text", text: raw }];
  }
  if (raw === undefined || raw === null) return [];
  const parts = requireArray(raw, path);
  const result: UnifiedContentPart[] = [];
  parts.forEach((entry, index) => {
    const part = requireObject(entry, `${path}[${index}]`);
    const type = requireString(part["type"], `${path}[${index}].type`);
    switch (type) {
      case "input_text":
      case "output_text":
      case "text": {
        const text = asString(part["text"]);
        if (text === undefined) {
          throw new GatewayError({ code: "INVALID_REQUEST", message: `${path}[${index}].text must be a string` });
        }
        result.push({ type: "text", text });
        break;
      }
      case "input_image": {
        const rawUrl = part["image_url"];
        const url =
          typeof rawUrl === "string"
            ? rawUrl
            : isRecord(rawUrl)
              ? asString(rawUrl["url"])
              : undefined;
        if (url === undefined) {
          throw new GatewayError({ code: "INVALID_REQUEST", message: `${path}[${index}].image_url must be a string or {url}` });
        }
        const source = imageSourceFromUrl(url);
        if (source.kind === "url" && !isHttpUrl(source.url)) {
          throw new GatewayError({ code: "INVALID_REQUEST", message: `${path}[${index}].image_url must be http(s) or a data URL` });
        }
        const image: UnifiedContentPart = { type: "image", source };
        const detail = asString(part["detail"]);
        if (detail === "auto" || detail === "low" || detail === "high") image.detail = detail;
        result.push(image);
        break;
      }
      case "refusal": {
        result.push({ type: "refusal", text: asString(part["refusal"]) ?? "" });
        break;
      }
      case "input_file":
        unsupported("content.input_file", "file inputs are not supported in this version");
        break;
      default:
        unsupported(`content.${type}`, `unsupported Responses content part type "${type}"`);
    }
  });
  return result;
}

function parseReasoningItem(item: JsonObject): UnifiedContentPart | undefined {
  const summaries = item["summary"];
  let text = "";
  if (Array.isArray(summaries)) {
    for (const entry of summaries) {
      if (isRecord(entry)) text += asString(entry["text"]) ?? "";
    }
  }
  if (text === "" && Array.isArray(item["content"])) {
    for (const entry of item["content"]) {
      if (isRecord(entry)) text += asString(entry["text"]) ?? "";
    }
  }
  const signature = asString(item["encrypted_content"]);
  if (text === "" && signature === undefined) return undefined;
  const part: UnifiedContentPart = { type: "thinking", text };
  if (signature !== undefined) part.signature = signature;
  return part;
}

interface InputParseState {
  system: UnifiedSystemInstruction[];
  messages: UnifiedMessage[];
}

function appendAssistantPart(state: InputParseState, part: UnifiedContentPart): void {
  const last = state.messages[state.messages.length - 1];
  if (last !== undefined && last.role === "assistant") {
    last.content.push(part);
    return;
  }
  state.messages.push({ role: "assistant", content: [part] });
}

function parseResponsesInput(input: unknown, state: InputParseState): void {
  if (input === undefined || input === null) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "input is required" });
  }
  if (typeof input === "string") {
    if (input !== "") state.messages.push({ role: "user", content: [{ type: "text", text: input }] });
    return;
  }
  const items = requireArray(input, "input");
  items.forEach((entry, index) => {
    const item = requireObject(entry, `input[${index}]`);
    const type = asString(item["type"]);
    const path = `input[${index}]`;

    if (type === "function_call") {
      const parsed = parseToolArguments(item["arguments"]);
      const part: UnifiedContentPart = {
        type: "tool_call",
        id: asString(item["call_id"]) ?? asString(item["id"]) ?? syntheticToolCallId("call", index),
        name: requireString(item["name"], `${path}.name`),
        arguments: parsed.arguments,
      };
      if (parsed.rawArguments !== undefined) part.rawArguments = parsed.rawArguments;
      appendAssistantPart(state, part);
      return;
    }

    if (type === "function_call_output") {
      const callId = requireString(item["call_id"], `${path}.call_id`);
      const output = item["output"];
      const content: UnifiedContentPart[] = [];
      if (typeof output === "string") {
        if (output !== "") content.push({ type: "text", text: output });
      } else if (Array.isArray(output)) {
        content.push(...parseResponsesContent(output, `${path}.output`));
      } else if (output !== undefined && output !== null) {
        content.push({ type: "text", text: JSON.stringify(output) });
      }
      state.messages.push({
        role: "tool",
        content: [{ type: "tool_result", toolCallId: callId, content }],
      });
      return;
    }

    if (type === "reasoning") {
      const part = parseReasoningItem(item);
      if (part) appendAssistantPart(state, part);
      return;
    }

    const role = asString(item["role"]);
    if (role === undefined && type !== "message") {
      unsupported(`input.${type ?? "unknown"}`, `unsupported Responses input item type "${type ?? "unknown"}"`);
    }
    const effectiveRole = role ?? "user";
    const content = parseResponsesContent(item["content"], `${path}.content`);
    if (effectiveRole === "system" || effectiveRole === "developer") {
      state.system.push({ role: effectiveRole, content });
      return;
    }
    if (effectiveRole === "user") {
      state.messages.push({ role: "user", content });
      return;
    }
    if (effectiveRole === "assistant") {
      for (const part of content) appendAssistantPart(state, part);
      return;
    }
    throw new GatewayError({
      code: "INVALID_REQUEST",
      message: `${path}.role "${effectiveRole}" is not supported`,
    });
  });
}

function parseInstructions(raw: unknown): UnifiedSystemInstruction[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") {
    return raw === "" ? [] : [{ role: "system", content: [{ type: "text", text: raw }] }];
  }
  return [{ role: "system", content: parseResponsesContent(raw, "instructions") }];
}

function parseTools(raw: unknown): UnifiedTool[] {
  if (raw === undefined || raw === null) return [];
  const list = requireArray(raw, "tools");
  return list.map((entry, index) => {
    const tool = requireObject(entry, `tools[${index}]`);
    const type = requireString(tool["type"], `tools[${index}].type`);
    if (type !== "function") {
      unsupported(`tools.${type}`, "only function tools can be routed by the gateway");
    }
    const name = requireString(tool["name"], `tools[${index}].name`);
    const description = optionalString(tool["description"], `tools[${index}].description`);
    const parameters = tool["parameters"];
    if (parameters !== undefined && !isRecord(parameters)) {
      throw new GatewayError({ code: "INVALID_REQUEST", message: `tools[${index}].parameters must be an object` });
    }
    const result: UnifiedTool = {
      name,
      inputSchema: isRecord(parameters) ? parameters : { type: "object", properties: {} },
    };
    if (description !== undefined) result.description = description;
    if (tool["strict"] === true) result.strict = true;
    return result;
  });
}

function parseToolChoice(raw: unknown, tools: UnifiedTool[]): UnifiedToolChoice {
  if (raw === undefined || raw === null) return { type: "auto" };
  if (typeof raw === "string") {
    if (raw === "auto") return { type: "auto" };
    if (raw === "none") return { type: "none" };
    if (raw === "required") return { type: "required" };
    throw new GatewayError({ code: "INVALID_REQUEST", message: `unsupported tool_choice "${raw}"` });
  }
  const choice = requireObject(raw, "tool_choice");
  const type = asString(choice["type"]);
  if (type === "function") {
    const name = requireString(choice["name"], "tool_choice.name");
    if (!tools.some((tool) => tool.name === name)) {
      throw new GatewayError({ code: "INVALID_REQUEST", message: `tool_choice references unknown tool "${name}"` });
    }
    return { type: "tool", name };
  }
  throw new GatewayError({ code: "INVALID_REQUEST", message: `unsupported tool_choice type "${type ?? "unknown"}"` });
}

function parseResponseFormat(body: JsonObject): UnifiedResponseFormat | undefined {
  const textConfig = getRecord(body, "text");
  if (!textConfig) return undefined;
  const format = getRecord(textConfig, "format");
  if (!format) return undefined;
  const type = requireString(format["type"], "text.format.type");
  if (type === "text") return { type: "text" };
  if (type === "json_object") return { type: "json_object" };
  if (type === "json_schema") {
    const result: UnifiedResponseFormat = {
      type: "json_schema",
      name: requireString(format["name"], "text.format.name"),
      schema: requireObject(format["schema"], "text.format.schema"),
    };
    const description = optionalString(format["description"], "text.format.description");
    if (description !== undefined) result.description = description;
    if (format["strict"] === true) result.strict = true;
    return result;
  }
  throw new GatewayError({ code: "INVALID_REQUEST", message: `unsupported text.format.type "${type}"` });
}

export function parseResponsesRequest(body: JsonObject, _ctx?: ParseRequestContext): UnifiedRequest {
  const model = requireString(body["model"], "model");
  const state: InputParseState = { system: parseInstructions(body["instructions"]), messages: [] };
  parseResponsesInput(body["input"], state);
  if (state.messages.length === 0) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "input must contain at least one message" });
  }

  const tools = parseTools(body["tools"]);
  const toolChoice = parseToolChoice(body["tool_choice"], tools);

  const reasoningConfig = getRecord(body, "reasoning");
  const effort = reasoningConfig ? asString(reasoningConfig["effort"]) : undefined;
  if (effort !== undefined && !EFFORTS.has(effort)) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: `unsupported reasoning effort "${effort}"` });
  }

  const metadataRecord = getRecord(body, "metadata");
  const userId = asString(body["user"]);
  const sessionId = metadataRecord ? asString(metadataRecord["session_id"]) ?? asString(metadataRecord["sessionId"]) : undefined;

  return finalizeRequest({
    sourceProtocol: "openai-responses",
    sourceBody: body,
    model,
    system: state.system,
    messages: state.messages,
    tools,
    toolChoice,
    parallelToolCalls: optionalBoolean(body["parallel_tool_calls"], "parallel_tool_calls"),
    maxOutputTokens: optionalNumber(body["max_output_tokens"], "max_output_tokens", { min: 1 }),
    temperature: optionalNumber(body["temperature"], "temperature", { min: 0, max: 2 }),
    topP: optionalNumber(body["top_p"], "top_p", { min: 0, max: 1 }),
    stopSequences: [],
    stream: optionalBoolean(body["stream"], "stream") ?? false,
    responseFormat: parseResponseFormat(body),
    reasoning: effort === undefined ? undefined : { effort: effort as "minimal" | "low" | "medium" | "high" },
    metadata: {
      ...(userId === undefined ? {} : { userId }),
      ...(sessionId === undefined ? {} : { sessionId }),
    },
    extensions: { source: "openai-responses", values: pickExtensions(body, KNOWN_KEYS) },
    raw: { protocol: "openai-responses", body },
  });
}

// ---------------------------------------------------------------------------
// IR → OpenAI Responses 上游请求
// ---------------------------------------------------------------------------

function renderInputContent(
  parts: readonly UnifiedContentPart[],
  role: "user" | "assistant",
  compat: ReturnType<typeof createCompatibilityContext>,
): JsonObject[] {
  const content: JsonObject[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      content.push({ type: role === "assistant" ? "output_text" : "input_text", text: part.text });
    } else if (part.type === "refusal") {
      content.push({ type: "refusal", refusal: part.text });
    } else if (part.type === "image") {
      if (role === "assistant") {
        reportUnsupported(compat, "assistant.image", "assistant messages cannot contain images");
        continue;
      }
      const url = imageSourceToUrl(part.source);
      if (url === undefined) {
        reportUnsupported(compat, "content.image.file", "Responses input cannot reference file ids");
        continue;
      }
      content.push({
        type: "input_image",
        image_url: url,
        ...(part.detail === undefined ? {} : { detail: part.detail }),
      });
    } else if (part.type === "thinking") {
      reportUnsupported(compat, "thinking", "synthesized reasoning items cannot be replayed to OpenAI Responses");
    } else if (part.type === "tool_call" || part.type === "tool_result") {
      reportUnsupported(compat, `content.${part.type}`, "tool blocks must be emitted as top-level input items");
    }
  }
  return content;
}

export function buildResponsesRequest(request: UnifiedRequest, ctx: BuildRequestContext): JsonObject {
  if (request.raw.protocol === "openai-responses" && ctx.policy === "passthrough") {
    const passthrough = cloneJsonObject(request.raw.body);
    passthrough["model"] = ctx.upstreamModel;
    return passthrough;
  }

  const compat = createCompatibilityContext(ctx.policy, request.raw.protocol, "openai-responses");
  if (ctx.capabilities && request.tools.length > 0 && !ctx.capabilities.supportsTools) {
    reportUnsupported(compat, "tools", "target model does not support tools");
  }

  const body: JsonObject = { model: ctx.upstreamModel, store: false };

  if (requestUsesCacheControl(request)) {
    reportUnsupported(
      compat,
      "prompt_cache_control",
      "OpenAI Responses manages prompt caching automatically; explicit cache_control was dropped",
    );
  }
  if (request.raw.protocol === "openai-responses" && request.raw.body["store"] === true) {
    reportEmulated(
      compat,
      "store",
      "gateway disables upstream response storage (store=false)",
    );
  }
  if (request.metadata.promptCacheKey !== undefined) {
    body["prompt_cache_key"] = request.metadata.promptCacheKey;
  }

  if (request.system.length > 0) {
    const parts: string[] = [];
    let rolesMerged = false;
    for (const instruction of request.system) {
      if (instruction.role === "developer") rolesMerged = true;
      for (const part of instruction.content) {
        if (part.type === "text") parts.push(part.text);
        else reportUnsupported(compat, `system.${part.type}`, "instructions only support text");
      }
    }
    if (rolesMerged) {
      reportEmulated(compat, "system.developer", "developer instructions were merged into instructions");
    }
    if (parts.length > 1) {
      reportEmulated(compat, "system.multiple", "multiple system instructions were joined into one string");
    }
    if (parts.length > 0) body["instructions"] = parts.join("\n\n");
  }

  const input: JsonObject[] = [];
  for (const message of request.messages) {
    if (message.role === "user") {
      const content = renderInputContent(message.content, "user", compat);
      if (content.length > 0) input.push({ type: "message", role: "user", content });
      continue;
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool_result") {
          reportUnsupported(compat, `tool.${part.type}`, "tool messages may only contain tool results");
          continue;
        }
        const texts: string[] = [];
        for (const item of part.content) {
          if (item.type === "text") texts.push(item.text);
          else reportUnsupported(compat, `tool_result.${item.type}`, "Responses function output only supports text");
        }
        if (texts.length === 0 && part.structured !== undefined) {
          texts.push(JSON.stringify(part.structured));
          reportEmulated(compat, "tool_result.structured", "structured tool result was serialized as JSON text");
        }
        input.push({ type: "function_call_output", call_id: part.toolCallId, output: texts.join("") });
      }
      continue;
    }

    const content = renderInputContent(
      message.content.filter((part) => part.type === "text" || part.type === "refusal"),
      "assistant",
      compat,
    );
    if (content.length > 0) {
      input.push({ type: "message", role: "assistant", content });
    }
    for (const part of message.content) {
      if (part.type === "tool_call") {
        input.push({
          type: "function_call",
          call_id: part.id,
          name: part.name,
          arguments: stringifyToolArguments(part.arguments, part.rawArguments),
        });
      } else if (part.type === "thinking") {
        reportUnsupported(compat, "thinking", "synthesized reasoning items cannot be replayed to OpenAI Responses");
      } else if (part.type === "image") {
        reportUnsupported(compat, "assistant.image", "assistant messages cannot contain images");
      }
    }
  }

  if (input.length === 0) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "converted input is empty" });
  }
  body["input"] = input;

  if (request.tools.length > 0) {
    body["tools"] = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.inputSchema,
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    }));
    const choice = request.toolChoice;
    if (choice.type === "auto") body["tool_choice"] = "auto";
    else if (choice.type === "none") body["tool_choice"] = "none";
    else if (choice.type === "required") body["tool_choice"] = "required";
    else body["tool_choice"] = { type: "function", name: choice.name };
    if (request.parallelToolCalls !== undefined) {
      body["parallel_tool_calls"] = request.parallelToolCalls;
    }
  }

  if (request.maxOutputTokens !== undefined) body["max_output_tokens"] = request.maxOutputTokens;
  if (request.temperature !== undefined) body["temperature"] = request.temperature;
  if (request.topP !== undefined) body["top_p"] = request.topP;
  if (request.topK !== undefined) reportUnsupported(compat, "top_k", "Responses has no top_k parameter");
  if (request.frequencyPenalty !== undefined) {
    reportUnsupported(compat, "frequency_penalty", "Responses has no frequency penalty");
  }
  if (request.presencePenalty !== undefined) {
    reportUnsupported(compat, "presence_penalty", "Responses has no presence penalty");
  }
  if (request.seed !== undefined) reportUnsupported(compat, "seed", "Responses has no seed parameter");
  if (request.stopSequences.length > 0) {
    reportUnsupported(compat, "stop_sequences", "Responses has no stop sequence parameter");
  }

  if (request.responseFormat !== undefined && request.responseFormat.type !== "text") {
    const format = request.responseFormat;
    if (format.type === "json_object") {
      body["text"] = { format: { type: "json_object" } };
    } else {
      body["text"] = {
        format: {
          type: "json_schema",
          name: format.name,
          schema: format.schema,
          ...(format.description === undefined ? {} : { description: format.description }),
          ...(format.strict === undefined ? {} : { strict: format.strict }),
        },
      };
    }
  }

  if (request.reasoning?.effort !== undefined) {
    body["reasoning"] = { effort: request.reasoning.effort };
  }
  if (request.reasoning?.budgetTokens !== undefined) {
    reportUnsupported(compat, "reasoning.budget_tokens", "Responses only accepts reasoning effort");
  }
  if (request.reasoning?.includeInOutput === false) {
    reportUnsupported(compat, "reasoning.include_in_output", "Responses cannot suppress reasoning output");
  }

  body["stream"] = request.stream;

  const extensionKeys = Object.keys(request.extensions.values);
  if (extensionKeys.length > 0) {
    reportUnsupported(compat, "extensions", `unmapped parameters were dropped: ${extensionKeys.join(", ")}`);
  }

  ctx.issues.push(...compat.issues);
  return body;
}

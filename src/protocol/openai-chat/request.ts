import { GatewayError } from "../../core/errors";
import { asString, getRecord, isRecord, type JsonObject } from "../../core/json";
import type {
  UnifiedContentPart,
  UnifiedMessage,
  UnifiedReasoningConfig,
  UnifiedRequest,
  UnifiedResponseFormat,
  UnifiedSystemInstruction,
  UnifiedTool,
  UnifiedToolChoice,
} from "../../ir";
import { finalizeRequest } from "../../ir";
import { createCompatibilityContext, reportEmulated, reportUnsupported } from "../../ir/compat";
import { cloneJsonObject, imageSourceFromUrl, imageSourceToUrl, pickExtensions } from "../shared/http";
import { requestUsesCacheControl } from "../shared/cache";
import {
  isHttpUrl,
  optionalBoolean,
  optionalNumber,
  optionalString,
  optionalStringArray,
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
  "messages",
  "tools",
  "functions",
  "tool_choice",
  "function_call",
  "parallel_tool_calls",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "top_k",
  "stop",
  "stream",
  "stream_options",
  "response_format",
  "reasoning_effort",
  "reasoning",
  "user",
  "metadata",
  "prompt_cache_key",
  "n",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "logprobs",
  "top_logprobs",
  "modalities",
  "audio",
] as const;

const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high"]);

function unsupported(feature: string, message: string): never {
  throw new GatewayError({
    code: "UNSUPPORTED_FEATURE",
    message: `${feature}: ${message}`,
    details: { feature },
  });
}

function parseImagePart(part: JsonObject, path: string): UnifiedContentPart {
  const imageUrl = requireObject(part["image_url"], `${path}.image_url`);
  const url = requireString(imageUrl["url"], `${path}.image_url.url`);
  const source = imageSourceFromUrl(url);
  if (source.kind === "url" && !isHttpUrl(source.url)) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: `${path}.image_url.url must be http(s) or a base64 data URL` });
  }
  const detail = optionalString(imageUrl["detail"], `${path}.image_url.detail`);
  const result: UnifiedContentPart = { type: "image", source };
  if (detail === "auto" || detail === "low" || detail === "high") {
    result.detail = detail;
  }
  return result;
}

function parseOpenAIChatContent(content: unknown, path: string): UnifiedContentPart[] {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") {
    return content === "" ? [] : [{ type: "text", text: content }];
  }
  const parts = requireArray(content, path);
  const result: UnifiedContentPart[] = [];
  parts.forEach((raw, index) => {
    const part = requireObject(raw, `${path}[${index}]`);
    const type = requireString(part["type"], `${path}[${index}].type`);
    switch (type) {
      case "text": {
        const text = asString(part["text"]);
        if (text === undefined) {
          throw new GatewayError({ code: "INVALID_REQUEST", message: `${path}[${index}].text must be a string` });
        }
        result.push({ type: "text", text });
        break;
      }
      case "image_url":
        result.push(parseImagePart(part, `${path}[${index}]`));
        break;
      case "refusal": {
        const text = asString(part["refusal"]) ?? "";
        result.push({ type: "refusal", text });
        break;
      }
      case "input_audio":
      case "file":
      case "audio":
        unsupported(`content.${type}`, "audio and file content are not supported in this version");
        break;
      default:
        unsupported(`content.${type}`, `unsupported content part type "${type}"`);
    }
  });
  return result;
}

function parseToolResultContent(content: unknown, path: string): UnifiedContentPart[] {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  const parts = requireArray(content, path);
  const result: UnifiedContentPart[] = [];
  parts.forEach((raw, index) => {
    const part = requireObject(raw, `${path}[${index}]`);
    const type = requireString(part["type"], `${path}[${index}].type`);
    if (type === "text") {
      const text = asString(part["text"]);
      if (text === undefined) {
        throw new GatewayError({ code: "INVALID_REQUEST", message: `${path}[${index}].text must be a string` });
      }
      result.push({ type: "text", text });
      return;
    }
    unsupported(`tool_result.${type}`, "tool results only support text content in OpenAI Chat");
  });
  return result;
}

function parseToolCalls(raw: unknown, path: string): UnifiedContentPart[] {
  if (raw === undefined || raw === null) return [];
  const calls = requireArray(raw, path);
  const result: UnifiedContentPart[] = [];
  calls.forEach((entry, index) => {
    const call = requireObject(entry, `${path}[${index}]`);
    const fn = requireObject(call["function"], `${path}[${index}].function`);
    const name = requireString(fn["name"], `${path}[${index}].function.name`);
    const parsed = parseToolArguments(fn["arguments"]);
    const id = asString(call["id"]) ?? syntheticToolCallId("call", index);
    const part: UnifiedContentPart = {
      type: "tool_call",
      id,
      name,
      arguments: parsed.arguments,
    };
    if (parsed.rawArguments !== undefined) part.rawArguments = parsed.rawArguments;
    result.push(part);
  });
  return result;
}

function parseTools(body: JsonObject): UnifiedTool[] {
  const tools: UnifiedTool[] = [];
  const rawTools = body["tools"];
  if (rawTools !== undefined) {
    const list = requireArray(rawTools, "tools");
    list.forEach((entry, index) => {
      const tool = requireObject(entry, `tools[${index}]`);
      const type = requireString(tool["type"], `tools[${index}].type`);
      if (type !== "function") {
        unsupported(`tools.${type}`, "only function tools can be routed by the gateway");
      }
      const fn = requireObject(tool["function"], `tools[${index}].function`);
      const name = requireString(fn["name"], `tools[${index}].function.name`);
      const description = optionalString(fn["description"], `tools[${index}].function.description`);
      const parameters = fn["parameters"];
      if (parameters !== undefined && !isRecord(parameters)) {
        throw new GatewayError({ code: "INVALID_REQUEST", message: `tools[${index}].function.parameters must be an object` });
      }
      const parsedTool: UnifiedTool = {
        name,
        inputSchema: isRecord(parameters) ? parameters : { type: "object", properties: {} },
      };
      if (description !== undefined) parsedTool.description = description;
      if (fn["strict"] === true) parsedTool.strict = true;
      tools.push(parsedTool);
    });
  }

  const legacyFunctions = body["functions"];
  if (legacyFunctions !== undefined && rawTools === undefined) {
    const list = requireArray(legacyFunctions, "functions");
    list.forEach((entry, index) => {
      const fn = requireObject(entry, `functions[${index}]`);
      const name = requireString(fn["name"], `functions[${index}].name`);
      const description = optionalString(fn["description"], `functions[${index}].description`);
      const parameters = fn["parameters"];
      if (parameters !== undefined && !isRecord(parameters)) {
        throw new GatewayError({ code: "INVALID_REQUEST", message: `functions[${index}].parameters must be an object` });
      }
      const parsedTool: UnifiedTool = {
        name,
        inputSchema: isRecord(parameters) ? parameters : { type: "object", properties: {} },
      };
      if (description !== undefined) parsedTool.description = description;
      tools.push(parsedTool);
    });
  }
  return tools;
}

function parseToolChoice(body: JsonObject, tools: UnifiedTool[]): UnifiedToolChoice {
  const raw = body["tool_choice"];
  const legacy = body["function_call"];
  const source = raw ?? legacy;
  if (source === undefined || source === null) return { type: "auto" };
  if (typeof source === "string") {
    if (source === "auto") return { type: "auto" };
    if (source === "none") return { type: "none" };
    if (source === "required" || source === "any") return { type: "required" };
    throw new GatewayError({ code: "INVALID_REQUEST", message: `unsupported tool_choice "${source}"` });
  }
  const choice = requireObject(source, "tool_choice");
  const type = asString(choice["type"]);
  if (type === "none") return { type: "none" };
  if (type === "required" || type === "any") return { type: "required" };
  if (type === "auto") return { type: "auto" };
  const fn = getRecord(choice, "function");
  const name = fn ? asString(fn["name"]) : asString(choice["name"]);
  if (!name) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "tool_choice.function.name is required" });
  }
  if (!tools.some((tool) => tool.name === name)) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: `tool_choice references unknown tool "${name}"` });
  }
  return { type: "tool", name };
}

function parseResponseFormat(body: JsonObject): UnifiedResponseFormat | undefined {
  const raw = body["response_format"];
  if (raw === undefined || raw === null) return undefined;
  const format = requireObject(raw, "response_format");
  const type = requireString(format["type"], "response_format.type");
  if (type === "text") return { type: "text" };
  if (type === "json_object") return { type: "json_object" };
  if (type === "json_schema") {
    const schemaConfig = requireObject(format["json_schema"], "response_format.json_schema");
    const name = requireString(schemaConfig["name"], "response_format.json_schema.name");
    const schema = requireObject(schemaConfig["schema"], "response_format.json_schema.schema");
    const result: UnifiedResponseFormat = { type: "json_schema", name, schema };
    const description = optionalString(schemaConfig["description"], "response_format.json_schema.description");
    if (description !== undefined) result.description = description;
    if (schemaConfig["strict"] === true) result.strict = true;
    return result;
  }
  throw new GatewayError({ code: "INVALID_REQUEST", message: `unsupported response_format.type "${type}"` });
}

function parseReasoning(body: JsonObject): UnifiedReasoningConfig | undefined {
  const direct = asString(body["reasoning_effort"]);
  const nested = getRecord(body, "reasoning");
  const effort = direct ?? (nested ? asString(nested["effort"]) : undefined);
  const budget = nested ? optionalNumber(nested["budget_tokens"], "reasoning.budget_tokens", { min: 1 }) : undefined;
  const includeInOutput = nested ? optionalBoolean(nested["include_in_output"], "reasoning.include_in_output") : undefined;
  if (effort !== undefined && !REASONING_EFFORTS.has(effort)) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: `unsupported reasoning effort "${effort}"` });
  }
  if (effort === undefined && budget === undefined && includeInOutput === undefined) return undefined;
  const result: UnifiedReasoningConfig = {};
  if (effort !== undefined) result.effort = effort as UnifiedReasoningConfig["effort"];
  if (budget !== undefined) result.budgetTokens = budget;
  if (includeInOutput !== undefined) result.includeInOutput = includeInOutput;
  return result;
}

function parseMetadata(body: JsonObject): { userId?: string; sessionId?: string; promptCacheKey?: string } {
  const metadata: { userId?: string; sessionId?: string; promptCacheKey?: string } = {};
  const user = asString(body["user"]);
  if (user !== undefined) metadata.userId = user;
  const promptCacheKey = asString(body["prompt_cache_key"]);
  if (promptCacheKey !== undefined) metadata.promptCacheKey = promptCacheKey;
  const custom = getRecord(body, "metadata");
  if (custom) {
    const sessionId = asString(custom["session_id"]) ?? asString(custom["sessionId"]);
    if (sessionId !== undefined) metadata.sessionId = sessionId;
  }
  return metadata;
}

export function parseOpenAIChatRequest(body: JsonObject, _ctx?: ParseRequestContext): UnifiedRequest {
  const model = requireString(body["model"], "model");
  const messagesRaw = requireArray(body["messages"], "messages");
  if (messagesRaw.length === 0) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "messages must not be empty" });
  }

  const system: UnifiedSystemInstruction[] = [];
  const messages: UnifiedMessage[] = [];

  messagesRaw.forEach((entry, index) => {
    const message = requireObject(entry, `messages[${index}]`);
    const role = requireString(message["role"], `messages[${index}].role`);
    switch (role) {
      case "system":
      case "developer": {
        system.push({
          role,
          content: parseOpenAIChatContent(message["content"], `messages[${index}].content`),
        });
        break;
      }
      case "user": {
        messages.push({
          role: "user",
          content: parseOpenAIChatContent(message["content"], `messages[${index}].content`),
        });
        break;
      }
      case "assistant": {
        const content: UnifiedContentPart[] = [];
        const reasoning = asString(message["reasoning_content"]) ?? asString(message["reasoning"]);
        if (reasoning !== undefined && reasoning !== "") {
          content.push({ type: "thinking", text: reasoning });
        }
        content.push(...parseOpenAIChatContent(message["content"], `messages[${index}].content`));
        content.push(...parseToolCalls(message["tool_calls"], `messages[${index}].tool_calls`));
        const legacyCall = getRecord(message, "function_call");
        if (legacyCall) {
          const name = requireString(legacyCall["name"], `messages[${index}].function_call.name`);
          const parsed = parseToolArguments(legacyCall["arguments"]);
          const part: UnifiedContentPart = {
            type: "tool_call",
            id: syntheticToolCallId("call_legacy", index),
            name,
            arguments: parsed.arguments,
          };
          if (parsed.rawArguments !== undefined) part.rawArguments = parsed.rawArguments;
          content.push(part);
        }
        messages.push({ role: "assistant", content });
        break;
      }
      case "tool": {
        const toolCallId = requireString(message["tool_call_id"], `messages[${index}].tool_call_id`);
        const toolResult: UnifiedContentPart = {
          type: "tool_result",
          toolCallId,
          content: parseToolResultContent(message["content"], `messages[${index}].content`),
        };
        if (message["is_error"] === true) toolResult.isError = true;
        messages.push({ role: "tool", content: [toolResult] });
        break;
      }
      default:
        throw new GatewayError({
          code: "INVALID_REQUEST",
          message: `messages[${index}].role "${role}" is not supported`,
        });
    }
  });

  const tools = parseTools(body);
  const toolChoice = parseToolChoice(body, tools);
  if (tools.length === 0 && toolChoice.type !== "auto" && toolChoice.type !== "none") {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "tool_choice requires at least one tool" });
  }

  const n = optionalNumber(body["n"], "n", { min: 1 });
  if (n !== undefined && n !== 1) {
    unsupported("n", "the gateway only supports a single choice");
  }
  if (body["logprobs"] === true) {
    unsupported("logprobs", "log probabilities are not supported");
  }
  if (body["audio"] !== undefined) {
    unsupported("audio", "audio output is not supported");
  }
  const modalities = body["modalities"];
  if (Array.isArray(modalities) && !modalities.every((item) => item === "text")) {
    unsupported("modalities", "only text output is supported");
  }

  const maxOutputTokens =
    optionalNumber(body["max_completion_tokens"], "max_completion_tokens", { min: 1 }) ??
    optionalNumber(body["max_tokens"], "max_tokens", { min: 1 });

  return finalizeRequest({
    sourceProtocol: "openai-chat",
    sourceBody: body,
    model,
    system,
    messages,
    tools,
    toolChoice,
    parallelToolCalls: optionalBoolean(body["parallel_tool_calls"], "parallel_tool_calls"),
    maxOutputTokens,
    temperature: optionalNumber(body["temperature"], "temperature", { min: 0, max: 2 }),
    topP: optionalNumber(body["top_p"], "top_p", { min: 0, max: 1 }),
    topK: optionalNumber(body["top_k"], "top_k", { min: 0 }),
    frequencyPenalty: optionalNumber(body["frequency_penalty"], "frequency_penalty", { min: -2, max: 2 }),
    presencePenalty: optionalNumber(body["presence_penalty"], "presence_penalty", { min: -2, max: 2 }),
    seed: optionalNumber(body["seed"], "seed"),
    stopSequences: optionalStringArray(body["stop"], "stop") ?? [],
    stream: optionalBoolean(body["stream"], "stream") ?? false,
    responseFormat: parseResponseFormat(body),
    reasoning: parseReasoning(body),
    metadata: parseMetadata(body),
    extensions: { source: "openai-chat", values: pickExtensions(body, KNOWN_KEYS) },
    raw: { protocol: "openai-chat", body },
  });
}

// ---------------------------------------------------------------------------
// IR → OpenAI Chat 上游请求
// ---------------------------------------------------------------------------

interface RenderRequestState {
  ctx: BuildRequestContext;
  compat: ReturnType<typeof createCompatibilityContext>;
}

function renderTextContent(
  parts: readonly UnifiedContentPart[],
  state: RenderRequestState,
): string {
  let text = "";
  for (const part of parts) {
    if (part.type === "text") {
      text += part.text;
    } else if (part.type === "refusal") {
      text += part.text;
    } else {
      reportUnsupported(state.compat, `content.${part.type}`, "OpenAI Chat text content cannot carry this block type");
    }
  }
  return text;
}

function renderUserContent(parts: readonly UnifiedContentPart[], state: RenderRequestState): string | JsonObject[] {
  const hasRichContent = parts.some((part) => part.type !== "text" && part.type !== "refusal");
  if (!hasRichContent) return renderTextContent(parts, state);

  const result: JsonObject[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      result.push({ type: "text", text: part.text });
    } else if (part.type === "refusal") {
      result.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      const url = imageSourceToUrl(part.source);
      if (url === undefined) {
        reportUnsupported(state.compat, "content.image.file", "OpenAI Chat cannot reference Gemini file ids");
        continue;
      }
      const imageUrl: JsonObject = { url };
      if (part.detail !== undefined) imageUrl["detail"] = part.detail;
      result.push({ type: "image_url", image_url: imageUrl });
    } else {
      reportUnsupported(state.compat, `content.${part.type}`, "this block type is not valid in an OpenAI Chat user message");
    }
  }
  return result;
}

function renderToolResult(part: UnifiedContentPart & { type: "tool_result" }, state: RenderRequestState): string {
  const texts: string[] = [];
  for (const item of part.content) {
    if (item.type === "text") texts.push(item.text);
  }
  if (part.content.some((item) => item.type === "image")) {
    reportUnsupported(state.compat, "tool_result.image", "OpenAI Chat tool messages cannot contain images");
  }
  if (part.content.some((item) => item.type !== "text" && item.type !== "image")) {
    reportUnsupported(state.compat, "tool_result.block", "unsupported tool result block type");
  }
  if (texts.length === 0 && part.structured !== undefined) {
    reportEmulated(state.compat, "tool_result.structured", "structured tool result was serialized as JSON text");
    return JSON.stringify(part.structured);
  }
  return texts.join("");
}

export function buildOpenAIChatRequest(request: UnifiedRequest, ctx: BuildRequestContext): JsonObject {
  if (request.raw.protocol === "openai-chat" && ctx.policy === "passthrough") {
    const passthrough = cloneJsonObject(request.raw.body);
    passthrough["model"] = ctx.upstreamModel;
    return passthrough;
  }

  const compat = createCompatibilityContext(ctx.policy, request.raw.protocol, "openai-chat");
  const state: RenderRequestState = { ctx, compat };

  if (requestUsesCacheControl(request)) {
    reportUnsupported(
      compat,
      "prompt_cache_control",
      "OpenAI Chat manages prompt caching automatically; explicit cache_control was dropped",
    );
  }

  if (ctx.capabilities) {
    if (request.tools.length > 0 && !ctx.capabilities.supportsTools) {
      reportUnsupported(compat, "tools", "target model does not support tools");
    }
    if (request.messages.some((message) => message.content.some((part) => part.type === "image")) && !ctx.capabilities.supportsVision) {
      reportUnsupported(compat, "vision", "target model does not support image input");
    }
    if (request.reasoning && !ctx.capabilities.supportsReasoning) {
      reportUnsupported(compat, "reasoning", "target model does not support reasoning");
    }
    if (request.responseFormat?.type === "json_schema" && !ctx.capabilities.supportsJsonSchema) {
      reportUnsupported(compat, "response_format.json_schema", "target model does not support JSON Schema output");
    }
  }

  const messages: JsonObject[] = [];
  for (const instruction of request.system) {
    messages.push({
      role: instruction.role,
      content: renderTextContent(instruction.content, state),
    });
  }

  for (const message of request.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: renderUserContent(message.content, state) });
      continue;
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool_result") {
          reportUnsupported(compat, `message.tool.${part.type}`, "tool role messages must contain tool results");
          continue;
        }
        const toolMessage: JsonObject = {
          role: "tool",
          tool_call_id: part.toolCallId,
          content: renderToolResult(part, state),
        };
        messages.push(toolMessage);
      }
      continue;
    }

    const text = renderTextContent(
      message.content.filter((part) => part.type === "text" || part.type === "refusal"),
      state,
    );
    const thinking = message.content
      .filter((part): part is UnifiedContentPart & { type: "thinking" } => part.type === "thinking")
      .map((part) => part.text)
      .join("");
    const toolCalls: JsonObject[] = [];
    for (const part of message.content) {
      if (part.type !== "tool_call") continue;
      toolCalls.push({
        id: part.id,
        type: "function",
        function: {
          name: part.name,
          arguments: stringifyToolArguments(part.arguments, part.rawArguments),
        },
      });
    }
    if (message.content.some((part) => part.type === "image")) {
      reportUnsupported(compat, "assistant.image", "assistant messages cannot contain images in OpenAI Chat");
    }
    const assistant: JsonObject = {
      role: "assistant",
      content: text === "" && toolCalls.length > 0 ? null : text,
    };
    if (thinking !== "") assistant["reasoning_content"] = thinking;
    if (toolCalls.length > 0) assistant["tool_calls"] = toolCalls;
    messages.push(assistant);
  }

  const body: JsonObject = { model: ctx.upstreamModel, messages };

  if (request.tools.length > 0) {
    body["tools"] = request.tools.map((tool) => {
      if (tool.strict === true) {
        return {
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: true,
          },
        };
      }
      return {
        type: "function",
        function: {
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          parameters: tool.inputSchema,
        },
      };
    });
    const choice = request.toolChoice;
    if (choice.type === "auto") body["tool_choice"] = "auto";
    else if (choice.type === "none") body["tool_choice"] = "none";
    else if (choice.type === "required") body["tool_choice"] = "required";
    else body["tool_choice"] = { type: "function", function: { name: choice.name } };
    if (request.parallelToolCalls !== undefined) {
      body["parallel_tool_calls"] = request.parallelToolCalls;
    }
  }

  if (request.maxOutputTokens !== undefined) {
    const field = asString(ctx.providerConfig?.["maxTokensField"]);
    body[field === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens"] = request.maxOutputTokens;
  }
  if (request.temperature !== undefined) body["temperature"] = request.temperature;
  if (request.topP !== undefined) body["top_p"] = request.topP;
  if (request.topK !== undefined) {
    reportUnsupported(compat, "top_k", "OpenAI Chat Completions has no top_k parameter");
  }
  if (request.frequencyPenalty !== undefined) body["frequency_penalty"] = request.frequencyPenalty;
  if (request.presencePenalty !== undefined) body["presence_penalty"] = request.presencePenalty;
  if (request.seed !== undefined) body["seed"] = request.seed;
  if (request.stopSequences.length > 0) body["stop"] = request.stopSequences;

  body["stream"] = request.stream;
  if (request.stream) {
    const includeUsage = ctx.providerConfig?.["includeStreamUsage"] !== false;
    if (includeUsage) body["stream_options"] = { include_usage: true };
  }

  if (request.responseFormat !== undefined) {
    const format = request.responseFormat;
    if (format.type === "text") {
      body["response_format"] = { type: "text" };
    } else if (format.type === "json_object") {
      body["response_format"] = { type: "json_object" };
    } else {
      body["response_format"] = {
        type: "json_schema",
        json_schema: {
          name: format.name,
          ...(format.description === undefined ? {} : { description: format.description }),
          schema: format.schema,
          ...(format.strict === undefined ? {} : { strict: format.strict }),
        },
      };
    }
  }

  if (request.metadata.promptCacheKey !== undefined) {
    body["prompt_cache_key"] = request.metadata.promptCacheKey;
  }

  if (request.reasoning !== undefined) {
    if (request.reasoning.effort !== undefined) {
      body["reasoning_effort"] = request.reasoning.effort;
    }
    if (request.reasoning.budgetTokens !== undefined) {
      reportUnsupported(
        compat,
        "reasoning.budget_tokens",
        "OpenAI Chat does not accept a reasoning token budget; use reasoning_effort instead",
      );
    }
    if (request.reasoning.includeInOutput === false) {
      // 不支持主动隐藏思考内容，交由上游默认行为处理。
      reportUnsupported(compat, "reasoning.include_in_output", "OpenAI Chat cannot suppress reasoning content");
    }
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

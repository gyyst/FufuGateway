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
import {
  createCompatibilityContext,
  reportEmulated,
  reportUnsupported,
} from "../../ir/compat";
import { cloneJsonObject, pickExtensions } from "../shared/http";
import { requestUsesCacheControl } from "../shared/cache";
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  parseToolArguments,
  requireArray,
  requireObject,
  requireString,
} from "../shared/validate";
import type { BuildRequestContext, ParseRequestContext } from "../types";

const KNOWN_KEYS = [
  "contents",
  "systemInstruction",
  "generationConfig",
  "tools",
  "toolConfig",
] as const;

const EFFORT_TO_BUDGET: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
};

function unsupported(feature: string, message: string): never {
  throw new GatewayError({
    code: "UNSUPPORTED_FEATURE",
    message: `${feature}: ${message}`,
    details: { feature },
  });
}

function parseImageFromUri(value: unknown, path: string): UnifiedContentPart | undefined {
  const fileData = isRecord(value) ? value : undefined;
  if (!fileData) return undefined;
  const mimeType = asString(fileData["mimeType"]);
  const uri = asString(fileData["fileUri"]);
  if (uri === undefined) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: `${path}.fileUri must be a string` });
  }
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    return { type: "image", source: { kind: "url", url: uri } };
  }
  const image: UnifiedContentPart = {
    type: "image",
    source: { kind: "file", fileId: uri, ...(mimeType === undefined ? {} : { mediaType: mimeType }) },
  };
  return image;
}

function parseGeminiParts(
  raw: unknown,
  path: string,
  callNames: Map<string, string>,
  indexRef: { value: number },
): { parts: UnifiedContentPart[]; toolResults: UnifiedContentPart[] } {
  const list = requireArray(raw, path);
  const parts: UnifiedContentPart[] = [];
  const toolResults: UnifiedContentPart[] = [];

  list.forEach((entry, index) => {
    const part = requireObject(entry, `${path}[${index}]`);
    const call = getRecord(part, "functionCall");
    if (call) {
      const name = requireString(call["name"], `${path}[${index}].functionCall.name`);
      const id = `call_gemini_${indexRef.value}`;
      indexRef.value += 1;
      const parsed = parseToolArguments(call["args"]);
      const toolCall: UnifiedContentPart = {
        type: "tool_call",
        id,
        name,
        arguments: parsed.arguments,
      };
      const signature = asString(part["thoughtSignature"]);
      if (signature !== undefined) toolCall.signature = signature;
      callNames.set(name, id);
      parts.push(toolCall);
      return;
    }

    const response = getRecord(part, "functionResponse");
    if (response) {
      const name = requireString(response["name"], `${path}[${index}].functionResponse.name`);
      const structured = response["response"];
      const text = structured === undefined ? "" : JSON.stringify(structured);
      const toolResult: UnifiedContentPart = {
        type: "tool_result",
        toolCallId: callNames.get(name) ?? `call_gemini_${name}`,
        content: text === "" ? [] : [{ type: "text", text }],
        ...(structured === undefined ? {} : { structured }),
      };
      toolResults.push(toolResult);
      return;
    }

    if (part["inlineData"] !== undefined) {
      const inline = requireObject(part["inlineData"], `${path}[${index}].inlineData`);
      parts.push({
        type: "image",
        source: {
          kind: "base64",
          mediaType: asString(inline["mimeType"]) ?? "application/octet-stream",
          data: asString(inline["data"]) ?? "",
        },
      });
      return;
    }

    if (part["fileData"] !== undefined) {
      const image = parseImageFromUri(part["fileData"], `${path}[${index}]`);
      if (image) parts.push(image);
      return;
    }

    const text = asString(part["text"]);
    if (text !== undefined) {
      if (part["thought"] === true) {
        const thinking: UnifiedContentPart = { type: "thinking", text };
        const signature = asString(part["thoughtSignature"]);
        if (signature !== undefined) thinking.signature = signature;
        parts.push(thinking);
      } else {
        parts.push({ type: "text", text });
      }
      return;
    }

    const executable = part["executableCode"] ?? part["codeExecutionResult"];
    if (executable !== undefined) {
      unsupported("content.executableCode", "code execution parts are not supported");
    }

    throw new GatewayError({
      code: "PROTOCOL_CONVERSION_ERROR",
      message: `Unsupported Gemini content part at ${path}[${index}]`,
    });
  });

  return { parts, toolResults };
}

function parseGeminiContents(raw: unknown): UnifiedMessage[] {
  const contents = requireArray(raw, "contents");
  if (contents.length === 0) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "contents must not be empty" });
  }
  const messages: UnifiedMessage[] = [];
  const callNames = new Map<string, string>();
  const indexRef = { value: 0 };

  contents.forEach((entry, index) => {
    const content = requireObject(entry, `contents[${index}]`);
    const role = asString(content["role"]) ?? "user";
    const parsed = parseGeminiParts(content["parts"], `contents[${index}].parts`, callNames, indexRef);

    if (parsed.toolResults.length > 0) {
      messages.push({ role: "tool", content: parsed.toolResults });
    }
    if (parsed.parts.length === 0) return;

    if (role === "model" || role === "assistant") {
      messages.push({ role: "assistant", content: parsed.parts });
      return;
    }
    if (role === "user") {
      messages.push({ role: "user", content: parsed.parts });
      return;
    }
    if (role === "function") {
      for (const part of parsed.parts) {
        messages.push({ role: "tool", content: [part] });
      }
      return;
    }
    throw new GatewayError({ code: "INVALID_REQUEST", message: `contents[${index}].role "${role}" is not supported` });
  });

  return messages;
}

function parseSystemInstruction(raw: unknown): UnifiedSystemInstruction[] {
  if (raw === undefined || raw === null) return [];
  const instruction = requireObject(raw, "systemInstruction");
  const parts = requireArray(instruction["parts"], "systemInstruction.parts");
  const content: UnifiedContentPart[] = [];
  parts.forEach((entry, index) => {
    const part = requireObject(entry, `systemInstruction.parts[${index}]`);
    const text = asString(part["text"]);
    if (text === undefined) {
      throw new GatewayError({ code: "INVALID_REQUEST", message: `systemInstruction.parts[${index}].text must be a string` });
    }
    content.push({ type: "text", text });
  });
  return content.length === 0 ? [] : [{ role: "system", content }];
}

function parseGeminiTools(raw: unknown): UnifiedTool[] {
  if (raw === undefined || raw === null) return [];
  const groups = requireArray(raw, "tools");
  const tools: UnifiedTool[] = [];
  groups.forEach((entry, groupIndex) => {
    const group = requireObject(entry, `tools[${groupIndex}]`);
    const declarations = group["functionDeclarations"];
    if (declarations === undefined) {
      const name = Object.keys(group)[0] ?? "unknown";
      unsupported(`tools.${name}`, "only function declarations can be routed by the gateway");
    }
    const list = requireArray(declarations, `tools[${groupIndex}].functionDeclarations`);
    list.forEach((item, index) => {
      const declaration = requireObject(item, `tools[${groupIndex}].functionDeclarations[${index}]`);
      const name = requireString(declaration["name"], `tools[${groupIndex}].functionDeclarations[${index}].name`);
      const description = optionalString(declaration["description"], `tools[${groupIndex}].functionDeclarations[${index}].description`);
      const parameters = declaration["parameters"];
      if (parameters !== undefined && !isRecord(parameters)) {
        throw new GatewayError({ code: "INVALID_REQUEST", message: `tools[${groupIndex}].functionDeclarations[${index}].parameters must be an object` });
      }
      const tool: UnifiedTool = {
        name,
        inputSchema: isRecord(parameters) ? parameters : { type: "object", properties: {} },
      };
      if (description !== undefined) tool.description = description;
      tools.push(tool);
    });
  });
  return tools;
}

function parseGeminiToolChoice(body: JsonObject, tools: UnifiedTool[]): UnifiedToolChoice {
  const toolConfig = getRecord(body, "toolConfig");
  const functionConfig = toolConfig ? getRecord(toolConfig, "functionCallingConfig") : undefined;
  if (!functionConfig) return { type: "auto" };
  const mode = asString(functionConfig["mode"]);
  if (mode === "NONE") return { type: "none" };
  if (mode === "AUTO" || mode === undefined) return { type: "auto" };
  if (mode !== "ANY") {
    throw new GatewayError({ code: "INVALID_REQUEST", message: `unsupported toolConfig mode "${mode}"` });
  }
  const allowed = functionConfig["allowedFunctionNames"];
  if (Array.isArray(allowed) && allowed.length === 1 && typeof allowed[0] === "string") {
    const name = allowed[0];
    if (tools.some((tool) => tool.name === name)) return { type: "tool", name };
  }
  return { type: "required" };
}

function parseGenerationConfig(body: JsonObject): {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  stopSequences: string[];
  responseFormat?: UnifiedResponseFormat;
  reasoning?: UnifiedReasoningConfig;
} {
  const config = getRecord(body, "generationConfig");
  if (!config) return { stopSequences: [] };

  const candidateCount = optionalNumber(config["candidateCount"], "generationConfig.candidateCount", { min: 1 });
  if (candidateCount !== undefined && candidateCount !== 1) {
    unsupported("generationConfig.candidateCount", "the gateway only supports a single candidate");
  }

  const stopSequences =
    config["stopSequences"] === undefined
      ? []
      : requireArray(config["stopSequences"], "generationConfig.stopSequences").map((value, index) =>
          requireString(value, `generationConfig.stopSequences[${index}]`),
        );

  const responseMimeType = asString(config["responseMimeType"]);
  const responseSchema = config["responseSchema"];
  let responseFormat: UnifiedResponseFormat | undefined;
  if (responseSchema !== undefined) {
    responseFormat = {
      type: "json_schema",
      name: "gemini_response",
      schema: requireObject(responseSchema, "generationConfig.responseSchema"),
    };
  } else if (responseMimeType === "application/json") {
    responseFormat = { type: "json_object" };
  } else if (responseMimeType === "text/plain") {
    responseFormat = { type: "text" };
  }

  const thinkingConfig = getRecord(config, "thinkingConfig");
  let reasoning: UnifiedReasoningConfig | undefined;
  if (thinkingConfig) {
    const budget = optionalNumber(thinkingConfig["thinkingBudget"], "generationConfig.thinkingConfig.thinkingBudget", { min: 0 });
    const includeThoughts = optionalBoolean(thinkingConfig["includeThoughts"], "generationConfig.thinkingConfig.includeThoughts");
    if ((budget !== undefined && budget > 0) || includeThoughts === true) {
      reasoning = {
        ...(budget !== undefined ? { budgetTokens: budget } : {}),
        ...(includeThoughts === undefined ? {} : { includeInOutput: includeThoughts }),
      };
    }
  }

  return {
    maxOutputTokens: optionalNumber(config["maxOutputTokens"], "generationConfig.maxOutputTokens", { min: 1 }),
    temperature: optionalNumber(config["temperature"], "generationConfig.temperature", { min: 0, max: 2 }),
    topP: optionalNumber(config["topP"], "generationConfig.topP", { min: 0, max: 1 }),
    topK: optionalNumber(config["topK"], "generationConfig.topK", { min: 0 }),
    frequencyPenalty: optionalNumber(config["frequencyPenalty"], "generationConfig.frequencyPenalty"),
    presencePenalty: optionalNumber(config["presencePenalty"], "generationConfig.presencePenalty"),
    seed: optionalNumber(config["seed"], "generationConfig.seed"),
    stopSequences,
    responseFormat,
    reasoning,
  };
}

export function parseGeminiRequest(body: JsonObject, ctx?: ParseRequestContext): UnifiedRequest {
  const model = ctx?.model;
  if (model === undefined || model === "") {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "model is required in the request path" });
  }
  const messages = parseGeminiContents(body["contents"]);
  const tools = parseGeminiTools(body["tools"]);
  const generation = parseGenerationConfig(body);

  return finalizeRequest({
    sourceProtocol: "gemini",
    sourceBody: body,
    model,
    system: parseSystemInstruction(body["systemInstruction"]),
    messages,
    tools,
    toolChoice: parseGeminiToolChoice(body, tools),
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    topP: generation.topP,
    topK: generation.topK,
    frequencyPenalty: generation.frequencyPenalty,
    presencePenalty: generation.presencePenalty,
    seed: generation.seed,
    stopSequences: generation.stopSequences,
    stream: false,
    responseFormat: generation.responseFormat,
    reasoning: generation.reasoning,
    metadata: {},
    extensions: { source: "gemini", values: pickExtensions(body, KNOWN_KEYS) },
    raw: { protocol: "gemini", body },
  });
}

// ---------------------------------------------------------------------------
// IR → Gemini 上游请求
// ---------------------------------------------------------------------------

function renderImagePart(
  part: UnifiedContentPart & { type: "image" },
  compat: ReturnType<typeof createCompatibilityContext>,
): JsonObject | undefined {
  if (part.source.kind === "base64") {
    return { inlineData: { mimeType: part.source.mediaType, data: part.source.data } };
  }
  if (part.source.kind === "url") {
    return { fileData: { fileUri: part.source.url } };
  }
  if (part.source.kind === "file") {
    return {
      fileData: {
        fileUri: part.source.fileId,
        ...(part.source.mediaType === undefined ? {} : { mimeType: part.source.mediaType }),
      },
    };
  }
  reportUnsupported(compat, "image.source", "unsupported image source");
  return undefined;
}

export function buildGeminiRequest(request: UnifiedRequest, ctx: BuildRequestContext): JsonObject {
  if (request.raw.protocol === "gemini" && ctx.policy === "passthrough") {
    return cloneJsonObject(request.raw.body);
  }

  const compat = createCompatibilityContext(ctx.policy, request.raw.protocol, "gemini");
  if (requestUsesCacheControl(request)) {
    reportUnsupported(
      compat,
      "prompt_cache_control",
      "Gemini does not accept Anthropic cache_control; use Gemini context caching via cachedContent instead",
    );
  }
  if (request.metadata.promptCacheKey !== undefined) {
    reportUnsupported(compat, "prompt_cache_key", "Gemini has no prompt_cache_key parameter");
  }
  if (ctx.capabilities && request.tools.length > 0 && !ctx.capabilities.supportsTools) {
    reportUnsupported(compat, "tools", "target model does not support tools");
  }

  const callNames = new Map<string, string>();
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.type === "tool_call") callNames.set(part.id, part.name);
    }
  }

  const contents: JsonObject[] = [];
  const pushContent = (role: "user" | "model", parts: JsonObject[]): void => {
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    if (last !== undefined && last["role"] === role) {
      (last["parts"] as JsonObject[]).push(...parts);
      return;
    }
    contents.push({ role, parts });
  };

  for (const message of request.messages) {
    if (message.role === "tool") {
      const parts: JsonObject[] = [];
      for (const part of message.content) {
        if (part.type !== "tool_result") {
          reportUnsupported(compat, `tool.${part.type}`, "Gemini function responses only accept tool results");
          continue;
        }
        const name = callNames.get(part.toolCallId);
        if (name === undefined) {
          reportEmulated(
            compat,
            "tool_result.name",
            "tool call name was not found; the call id was used as the function name",
          );
        }
        const texts: string[] = [];
        for (const item of part.content) {
          if (item.type === "text") texts.push(item.text);
          else reportUnsupported(compat, `tool_result.${item.type}`, "Gemini function responses only support text");
        }
        const responseValue =
          part.structured !== undefined
            ? part.structured
            : { result: texts.join("") };
        parts.push({
          functionResponse: {
            name: name ?? part.toolCallId,
            response: isRecord(responseValue) ? responseValue : { result: responseValue },
          },
        });
      }
      pushContent("user", parts);
      continue;
    }

    const parts: JsonObject[] = [];
    for (const part of message.content) {
      if (part.type === "text") {
        parts.push({ text: part.text });
      } else if (part.type === "refusal") {
        parts.push({ text: part.text });
        reportEmulated(compat, "refusal", "refusal was converted to a text part");
      } else if (part.type === "image") {
        const rendered = renderImagePart(part, compat);
        if (rendered) parts.push(rendered);
      } else if (part.type === "thinking") {
        parts.push({
          text: part.text,
          thought: true,
          ...(part.signature === undefined ? {} : { thoughtSignature: part.signature }),
        });
      } else if (part.type === "tool_call") {
        parts.push({
          functionCall: { name: part.name, args: part.arguments },
          ...(part.signature === undefined ? {} : { thoughtSignature: part.signature }),
        });
      } else if (part.type === "tool_result") {
        reportUnsupported(compat, "content.tool_result", "tool results must appear in tool messages");
      }
    }
    const role = message.role === "assistant" ? "model" : "user";
    pushContent(role, parts);
  }

  if (contents.length === 0) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "converted contents are empty" });
  }

  const body: JsonObject = { contents };

  if (request.system.length > 0) {
    const parts: JsonObject[] = [];
    for (const instruction of request.system) {
      for (const part of instruction.content) {
        if (part.type === "text") parts.push({ text: part.text });
        else reportUnsupported(compat, `system.${part.type}`, "Gemini system instructions only support text");
      }
    }
    if (parts.length > 0) body["systemInstruction"] = { parts };
  }

  const generationConfig: JsonObject = {};
  if (request.maxOutputTokens !== undefined) generationConfig["maxOutputTokens"] = request.maxOutputTokens;
  if (request.temperature !== undefined) generationConfig["temperature"] = request.temperature;
  if (request.topP !== undefined) generationConfig["topP"] = request.topP;
  if (request.topK !== undefined) generationConfig["topK"] = request.topK;
  if (request.frequencyPenalty !== undefined) generationConfig["frequencyPenalty"] = request.frequencyPenalty;
  if (request.presencePenalty !== undefined) generationConfig["presencePenalty"] = request.presencePenalty;
  if (request.seed !== undefined) generationConfig["seed"] = request.seed;
  if (request.stopSequences.length > 0) generationConfig["stopSequences"] = request.stopSequences;

  if (request.responseFormat !== undefined) {
    const format = request.responseFormat;
    if (format.type === "text") {
      generationConfig["responseMimeType"] = "text/plain";
    } else if (format.type === "json_object") {
      generationConfig["responseMimeType"] = "application/json";
    } else {
      generationConfig["responseMimeType"] = "application/json";
      generationConfig["responseSchema"] = format.schema;
    }
  }

  const thinkingBudget =
    request.reasoning?.budgetTokens ??
    (request.reasoning?.effort !== undefined ? EFFORT_TO_BUDGET[request.reasoning.effort] : undefined);
  if (request.reasoning?.effort !== undefined && request.reasoning.budgetTokens === undefined) {
    reportEmulated(
      compat,
      "reasoning.effort",
      `reasoning effort "${request.reasoning.effort}" was mapped to a thinking budget`,
    );
  }
  if (thinkingBudget !== undefined || request.reasoning !== undefined) {
    const thinkingConfig: JsonObject = {};
    if (thinkingBudget !== undefined) thinkingConfig["thinkingBudget"] = thinkingBudget;
    if (request.reasoning?.includeInOutput !== undefined) {
      thinkingConfig["includeThoughts"] = request.reasoning.includeInOutput;
    } else {
      thinkingConfig["includeThoughts"] = true;
    }
    generationConfig["thinkingConfig"] = thinkingConfig;
  }

  if (Object.keys(generationConfig).length > 0) body["generationConfig"] = generationConfig;

  if (request.tools.length > 0) {
    body["tools"] = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          parameters: tool.inputSchema,
        })),
      },
    ];
    const choice = request.toolChoice;
    if (choice.type === "none") {
      body["toolConfig"] = { functionCallingConfig: { mode: "NONE" } };
    } else if (choice.type === "required") {
      body["toolConfig"] = { functionCallingConfig: { mode: "ANY" } };
    } else if (choice.type === "tool") {
      body["toolConfig"] = {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.name] },
      };
    } else {
      body["toolConfig"] = { functionCallingConfig: { mode: "AUTO" } };
    }
    if (request.parallelToolCalls === false) {
      reportUnsupported(compat, "parallel_tool_calls", "Gemini has no parameter to disable parallel tool calls");
    }
  }

  const extensionKeys = Object.keys(request.extensions.values);
  if (extensionKeys.length > 0) {
    reportUnsupported(compat, "extensions", `unmapped parameters were dropped: ${extensionKeys.join(", ")}`);
  }

  ctx.issues.push(...compat.issues);
  return body;
}

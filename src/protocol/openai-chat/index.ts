import type { ProtocolAdapter } from "../types";
import { buildOpenAIChatRequest, parseOpenAIChatRequest } from "./request";
import { parseOpenAIChatStream, renderOpenAIChatStream } from "./stream";
import {
  parseOpenAIChatError,
  parseOpenAIChatResponse,
  renderOpenAIChatError,
  renderOpenAIChatModels,
  renderOpenAIChatResponse,
} from "./response";

export const openAIChatProtocol: ProtocolAdapter = {
  id: "openai-chat",
  parseRequest: parseOpenAIChatRequest,
  buildUpstreamRequest: buildOpenAIChatRequest,
  parseResponse: parseOpenAIChatResponse,
  renderResponse: renderOpenAIChatResponse,
  parseUpstreamError: parseOpenAIChatError,
  renderError: renderOpenAIChatError,
  renderModels: renderOpenAIChatModels,
  parseStream: parseOpenAIChatStream,
  renderStream: renderOpenAIChatStream,
};

import type { ProtocolAdapter } from "../types";
import { buildGeminiRequest, parseGeminiRequest } from "./request";
import { parseGeminiStream, renderGeminiStream } from "./stream";
import {
  parseGeminiError,
  parseGeminiResponse,
  renderGeminiError,
  renderGeminiModels,
  renderGeminiResponse,
} from "./response";

export const geminiProtocol: ProtocolAdapter = {
  id: "gemini",
  parseRequest: parseGeminiRequest,
  buildUpstreamRequest: buildGeminiRequest,
  parseResponse: parseGeminiResponse,
  renderResponse: renderGeminiResponse,
  parseUpstreamError: parseGeminiError,
  renderError: renderGeminiError,
  renderModels: renderGeminiModels,
  parseStream: parseGeminiStream,
  renderStream: renderGeminiStream,
};

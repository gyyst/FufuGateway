import type { ProtocolAdapter } from "../types";
import { buildAnthropicRequest, parseAnthropicRequest } from "./request";
import { parseAnthropicStream, renderAnthropicStream } from "./stream";
import {
  parseAnthropicError,
  parseAnthropicResponse,
  renderAnthropicError,
  renderAnthropicModels,
  renderAnthropicResponse,
} from "./response";

export const anthropicProtocol: ProtocolAdapter = {
  id: "anthropic",
  parseRequest: parseAnthropicRequest,
  buildUpstreamRequest: buildAnthropicRequest,
  parseResponse: parseAnthropicResponse,
  renderResponse: renderAnthropicResponse,
  parseUpstreamError: parseAnthropicError,
  renderError: renderAnthropicError,
  renderModels: renderAnthropicModels,
  parseStream: parseAnthropicStream,
  renderStream: renderAnthropicStream,
};

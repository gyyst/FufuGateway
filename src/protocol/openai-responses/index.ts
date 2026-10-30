import type { ProtocolAdapter } from "../types";
import { buildResponsesRequest, parseResponsesRequest } from "./request";
import { parseResponsesStream, renderResponsesStream } from "./stream";
import {
  parseResponsesError,
  parseResponsesResponse,
  renderResponsesError,
  renderResponsesModels,
  renderResponsesResponse,
} from "./response";

export const openAIResponsesProtocol: ProtocolAdapter = {
  id: "openai-responses",
  parseRequest: parseResponsesRequest,
  buildUpstreamRequest: buildResponsesRequest,
  parseResponse: parseResponsesResponse,
  renderResponse: renderResponsesResponse,
  parseUpstreamError: parseResponsesError,
  renderError: renderResponsesError,
  renderModels: renderResponsesModels,
  parseStream: parseResponsesStream,
  renderStream: renderResponsesStream,
};

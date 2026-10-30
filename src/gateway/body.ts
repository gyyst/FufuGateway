import type { Context } from "hono";
import type { AppEnv } from "../app";
import { GatewayError } from "../core/errors";
import { isRecord, parseJsonText, type JsonObject } from "../core/json";
import { DEFAULT_MAX_BODY_BYTES } from "../core/limits";

/** 读取请求体并强制执行大小上限。 */
export async function readRequestBytes(
  c: Context<AppEnv>,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<Uint8Array> {
  const declared = c.req.header("content-length");
  if (declared !== undefined) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new GatewayError({
        code: "REQUEST_LIMIT_EXCEEDED",
        message: `Request body exceeds ${maxBytes} bytes`,
        status: 413,
      });
    }
  }

  const buffer = await c.req.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new GatewayError({
      code: "REQUEST_LIMIT_EXCEEDED",
      message: `Request body exceeds ${maxBytes} bytes`,
      status: 413,
    });
  }
  return new Uint8Array(buffer);
}

export async function readRequestBodyText(
  c: Context<AppEnv>,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<string> {
  const bytes = await readRequestBytes(c, maxBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new GatewayError({
      code: "INVALID_REQUEST",
      message: "Request body must be valid UTF-8",
    });
  }
}

export async function readJsonBody(
  c: Context<AppEnv>,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
  const text = await readRequestBodyText(c, maxBytes);
  if (text.trim() === "") {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "Request body is required" });
  }
  try {
    return parseJsonText(text);
  } catch {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "Request body must be valid JSON" });
  }
}

export async function readJsonObjectBody(
  c: Context<AppEnv>,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<JsonObject> {
  const body = await readJsonBody(c, maxBytes);
  if (!isRecord(body)) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "Request body must be a JSON object" });
  }
  return body;
}

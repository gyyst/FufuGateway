import { GatewayError } from "../core/errors";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
]);

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

function parseIpv4(hostname: string): number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    numbers.push(value);
  }
  return numbers;
}

function isPrivateIpv4(parts: number[]): boolean {
  const [a = 0, b = 0] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedIpv6(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) {
    return true;
  }
  if (value.startsWith("::ffff:")) {
    const mapped = parseIpv4(value.slice("::ffff:".length));
    if (mapped) return isPrivateIpv4(mapped);
  }
  return false;
}

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

export interface UpstreamUrlOptions {
  allowPrivate: boolean;
}

/**
 * 校验管理员配置的上游地址，防止 SSRF。
 * 仅允许 https（开发模式可放宽），禁止私有/环回/元数据地址与 URL 内嵌凭据。
 */
export function validateUpstreamBaseUrl(raw: string, options: UpstreamUrlOptions): URL {
  if (raw.length > 2048) {
    throw invalid("upstream URL is too long");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid("upstream URL is not a valid absolute URL");
  }

  const allowedProtocols = options.allowPrivate ? ["https:", "http:"] : ["https:"];
  if (!allowedProtocols.includes(url.protocol)) {
    throw invalid(`upstream URL must use ${allowedProtocols.join(" or ")}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw invalid("upstream URL must not contain credentials");
  }
  if (url.hash !== "") {
    throw invalid("upstream URL must not contain a fragment");
  }

  const hostname = url.hostname.toLowerCase();
  if (!options.allowPrivate) {
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      throw invalid("upstream host is not allowed");
    }
    for (const suffix of BLOCKED_SUFFIXES) {
      if (hostname.endsWith(suffix)) throw invalid("upstream host is not allowed");
    }
  }

  if (isIpLiteral(hostname)) {
    const ipv4 = parseIpv4(hostname);
    if (ipv4 && isPrivateIpv4(ipv4) && !options.allowPrivate) {
      throw invalid("upstream IP address is not allowed");
    }
    if (!ipv4 && isBlockedIpv6(hostname) && !options.allowPrivate) {
      throw invalid("upstream IP address is not allowed");
    }
  }

  const port = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
  if (!options.allowPrivate && port !== "443") {
    throw invalid("upstream URL must use port 443");
  }

  return url;
}

function invalid(message: string): GatewayError {
  return new GatewayError({ code: "CONFIG_INVALID", message });
}

export function isPrivateUpstreamAllowed(env: { ALLOW_PRIVATE_UPSTREAMS?: string }): boolean {
  return env.ALLOW_PRIVATE_UPSTREAMS === "true";
}

const EXTRA_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "cookie",
  "set-cookie",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
]);

/** 校验并规范化管理员配置的自定义请求头。 */
export function sanitizeCustomHeaders(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid("customHeaders must be an object");
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const lower = name.toLowerCase();
    if (!EXTRA_HEADER_NAME.test(name)) {
      throw invalid(`custom header name "${name}" is invalid`);
    }
    if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith("x-forwarded-")) {
      throw invalid(`custom header "${name}" is not allowed`);
    }
    if (typeof value !== "string" || /[\r\n\0]/.test(value) || value.length > 4096) {
      throw invalid(`custom header "${name}" has an invalid value`);
    }
    result[lower] = value;
  }
  return result;
}

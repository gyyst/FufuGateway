/** 结构化日志。默认输出单行 JSON，便于 Workers 日志检索。 */

import { redact } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface CreateLoggerOptions {
  level?: LogLevel | string;
  base?: LogFields;
  sink?: (line: string) => void;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function parseLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

function serializeError(error: Error): LogFields {
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...(error.cause === undefined ? {} : { cause: redact(error.cause) }),
  };
}

export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) return serializeError(error);
  return { value: redact(error) };
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const threshold = LEVEL_WEIGHT[parseLevel(options.level)];
  const base = options.base ?? {};
  const sink = options.sink ?? ((line: string) => console.log(line));

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_WEIGHT[level] < threshold) return;
    const payload = redact({
      ...base,
      ...fields,
      level,
      msg: message,
      ts: new Date().toISOString(),
    });
    try {
      sink(JSON.stringify(payload));
    } catch (error) {
      sink(
        JSON.stringify({
          level: "error",
          msg: "log.serialization_failed",
          ts: new Date().toISOString(),
          error: errorFields(error),
        }),
      );
    }
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger({ level: parseLevel(options.level), base: { ...base, ...fields }, sink }),
  };
}

/** 测试与调试用的静默日志器。 */
export const silentLogger: Logger = createLogger({ sink: () => undefined });

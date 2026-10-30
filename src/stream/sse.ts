import { GatewayError } from "../core/errors";

/** 一条已解析的 SSE 消息；comment 表示心跳注释行。 */
export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
  comment?: boolean;
}

export interface SseParserOptions {
  /** 单个事件 data 的最大字符数，防止恶意上游耗尽内存。 */
  maxEventBytes?: number;
}

const DEFAULT_MAX_EVENT_CHARS = 1024 * 1024;

/**
 * 增量 SSE 解析器。
 *
 * 处理跨 chunk 的事件边界、CRLF/LF/CR、多行 data、注释心跳与 UTF-8
 * 多字节字符（由调用方的 TextDecoder 流式解码保证）。
 */
export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];
  private dataSize = 0;
  private eventName: string | undefined;
  private lastId: string | undefined;
  private retry: number | undefined;
  private readonly maxEventChars: number;

  constructor(options: SseParserOptions = {}) {
    this.maxEventChars = options.maxEventBytes ?? DEFAULT_MAX_EVENT_CHARS;
  }

  /** 喂入解码后的文本，返回本次产生的完整事件。 */
  push(text: string): SseMessage[] {
    if (text !== "") this.buffer += text;
    const output: SseMessage[] = [];

    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.buffer);
      if (match === null) break;
      const index = match.index;
      // 末尾的 \r 可能是 \r\n 的前半部分，等待下一个 chunk。
      if (match[0] === "\r" && index === this.buffer.length - 1) break;

      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + match[0].length);
      this.consumeLine(line, output);
    }
    return output;
  }

  /** 流结束时处理残留内容。 */
  finish(): SseMessage[] {
    const output: SseMessage[] = [];
    if (this.buffer !== "") {
      const line = this.buffer.replace(/\r$/, "");
      this.buffer = "";
      this.consumeLine(line, output);
    }
    const dispatched = this.dispatch();
    if (dispatched !== undefined) output.push(dispatched);
    return output;
  }

  private consumeLine(line: string, output: SseMessage[]): void {
    if (line.length > this.maxEventChars) {
      throw new GatewayError({
        code: "PROTOCOL_CONVERSION_ERROR",
        message: "SSE line exceeds the configured size limit",
      });
    }
    if (line === "") {
      const dispatched = this.dispatch();
      if (dispatched !== undefined) output.push(dispatched);
      return;
    }
    if (line.startsWith(":")) {
      // 注释心跳：立即暴露给调用方用于空闲超时复位。
      output.push({ comment: true, data: line.slice(1) });
      return;
    }

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "data":
        this.dataSize += value.length + 1;
        if (this.dataSize > this.maxEventChars) {
          throw new GatewayError({
            code: "PROTOCOL_CONVERSION_ERROR",
            message: "SSE event exceeds the configured size limit",
          });
        }
        this.dataLines.push(value);
        break;
      case "event":
        this.eventName = value;
        break;
      case "id":
        this.lastId = value;
        break;
      case "retry": {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed >= 0) this.retry = parsed;
        break;
      }
      default:
        // 未知字段按 SSE 规范忽略。
        break;
    }
  }

  private dispatch(): SseMessage | undefined {
    if (this.dataLines.length === 0) {
      this.resetEvent();
      return undefined;
    }
    const message: SseMessage = { data: this.dataLines.join("\n") };
    if (this.eventName !== undefined) message.event = this.eventName;
    if (this.lastId !== undefined) message.id = this.lastId;
    if (this.retry !== undefined) message.retry = this.retry;
    this.resetEvent();
    return message;
  }

  private resetEvent(): void {
    this.dataLines = [];
    this.dataSize = 0;
    this.eventName = undefined;
    this.retry = undefined;
  }
}

/** 基于 TransformStream 的 SSE 解析器。 */
export function createSseParserStream(
  options: SseParserOptions = {},
): TransformStream<Uint8Array, SseMessage> {
  const parser = new SseParser(options);
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });
  return new TransformStream<Uint8Array, SseMessage>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      for (const message of parser.push(text)) controller.enqueue(message);
    },
    flush(controller) {
      const text = decoder.decode();
      for (const message of parser.push(text)) controller.enqueue(message);
      for (const message of parser.finish()) controller.enqueue(message);
    },
  });
}

export interface SseSource {
  events: AsyncIterable<SseMessage>;
  /** 主动取消读取；会中断挂起的 read()，用于超时与下游断开。 */
  cancel(): Promise<void>;
}

/**
 * 创建可取消的 SSE 读取源。
 *
 * 外部 cancel() 直接取消底层 reader，因此即使消费方正阻塞在 next() 上，
 * 也能让异步生成器及时退出，避免流取消时挂起。
 */
export function createSseSource(
  stream: ReadableStream<Uint8Array>,
  options: SseParserOptions = {},
): SseSource {
  const reader = stream.getReader();
  const parser = new SseParser(options);
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });
  let cancelled = false;
  let released = false;

  const release = (): void => {
    if (released) return;
    released = true;
    try {
      reader.releaseLock();
    } catch {
      // reader 可能已被释放。
    }
  };

  const cancel = async (): Promise<void> => {
    if (cancelled) return;
    cancelled = true;
    try {
      await reader.cancel();
    } catch {
      // 上游已关闭时 cancel 可能抛错，忽略。
    }
    release();
  };

  async function* iterate(): AsyncGenerator<SseMessage> {
    try {
      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const message of parser.push(text)) yield message;
      }
      if (cancelled) return;
      const tail = decoder.decode();
      for (const message of parser.push(tail)) yield message;
      for (const message of parser.finish()) yield message;
    } finally {
      await cancel();
    }
  }

  return {
    events: {
      [Symbol.asyncIterator]: iterate,
    },
    cancel,
  };
}

/** 读取上游字节流并产出 SSE 消息（包装 createSseSource）。 */
export async function* readSseMessages(
  stream: ReadableStream<Uint8Array>,
  options: SseParserOptions = {},
): AsyncGenerator<SseMessage> {
  const source = createSseSource(stream, options);
  try {
    for await (const message of source.events) yield message;
  } finally {
    await source.cancel();
  }
}

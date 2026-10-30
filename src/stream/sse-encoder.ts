import type { SseMessage } from "./sse";
import type { ProtocolHttpResponse } from "../protocol/types";

const encoder = new TextEncoder();

/** 编码单条 SSE 消息。 */
export function encodeSse(message: SseMessage): Uint8Array {
  let output = "";
  if (message.comment === true) {
    output += `: ${message.data}\n\n`;
    return encoder.encode(output);
  }
  if (message.event !== undefined && message.event !== "") output += `event: ${message.event}\n`;
  if (message.id !== undefined) output += `id: ${message.id}\n`;
  if (message.retry !== undefined) output += `retry: ${message.retry}\n`;
  for (const line of message.data.split("\n")) {
    output += `data: ${line}\n`;
  }
  output += "\n";
  return encoder.encode(output);
}

export function encodeSseData(data: string, event?: string): Uint8Array {
  return encodeSse(event === undefined ? { data } : { data, event });
}

export function encodeSseComment(text: string): Uint8Array {
  return encodeSse({ comment: true, data: text });
}

export interface EventStreamEncoder<T> {
  encode(event: T): Uint8Array[];
  isTerminal(event: T): boolean;
}

/**
 * 将统一事件异步序列转换为下游字节流。
 * 使用 pull 驱动以保留背压，并在取消时释放上游迭代器。
 */
export function createEventStream<T>(
  events: AsyncIterable<T>,
  encoder: EventStreamEncoder<T>,
): ReadableStream<Uint8Array> {
  const iterator = events[Symbol.asyncIterator]();
  let finished = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        // 某些事件（如 block_start）不产生字节；必须继续推进，
        // 否则消费者会一直等待同一个 pending read。
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) {
            finished = true;
            controller.close();
            return;
          }
          const frames = encoder.encode(next.value);
          for (const frame of frames) {
            controller.enqueue(frame);
          }
          if (encoder.isTerminal(next.value)) {
            finished = true;
            try {
              await iterator.return?.();
            } catch {
              // 上游清理失败不影响已完成的响应。
            }
            controller.close();
            return;
          }
          if (frames.length > 0) return;
        }
      } catch (error) {
        finished = true;
        controller.error(error);
      }
    },
    async cancel(reason) {
      finished = true;
      try {
        await iterator.return?.(reason);
      } catch {
        // 忽略清理异常。
      }
    },
  });
}

export function sseResponse(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
): ProtocolHttpResponse {
  return {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      ...headers,
    },
    body,
  };
}

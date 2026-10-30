import { describe, expect, it } from "vitest";
import { GatewayError } from "../../src/core/errors";
import type { UnifiedStreamEvent } from "../../src/ir";
import { readSseMessages, type SseMessage } from "../../src/stream/sse";
import { protocolRegistry } from "../../src/protocol/registry";
import type { ProtocolAdapter } from "../../src/protocol/types";

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collectSse(chunks: Uint8Array[], maxEventBytes?: number): Promise<SseMessage[]> {
  const messages: SseMessage[] = [];
  for await (const message of readSseMessages(streamFromChunks(chunks), { maxEventBytes })) {
    messages.push(message);
  }
  return messages;
}

const encoder = new TextEncoder();

describe("SSE 解析器", () => {
  it("解析基本事件与多行 data", async () => {
    const messages = await collectSse([
      encoder.encode('event: message\ndata: line1\ndata: line2\n\ndata: {"ok":true}\n\n'),
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.event).toBe("message");
    expect(messages[0]?.data).toBe("line1\nline2");
    expect(messages[1]?.data).toBe('{"ok":true}');
  });

  it("支持 CRLF、LF 与 CR 行结束符", async () => {
    const messages = await collectSse([
      encoder.encode("data: a\r\n\r\ndata: b\n\ndata: c\r\r"),
    ]);
    expect(messages.map((message) => message.data)).toEqual(["a", "b", "c"]);
  });

  it("解析心跳注释", async () => {
    const messages = await collectSse([encoder.encode(": ping\n\ndata: x\n\n")]);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.comment).toBe(true);
    expect(messages[0]?.data).toBe(" ping");
    expect(messages[1]?.data).toBe("x");
  });

  it("在任意字节边界切分都能正确解析（含 UTF-8 多字节字符）", async () => {
    const payload = 'data: {"text":"你好，世界 🌍"}\n\n';
    const bytes = encoder.encode(payload);
    for (let split = 0; split <= bytes.length; split += 1) {
      const messages = await collectSse([bytes.slice(0, split), bytes.slice(split)]);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.data).toBe('{"text":"你好，世界 🌍"}');
    }
  });

  it("逐字节输入仍能解析", async () => {
    const bytes = encoder.encode("data: 逐字节\n\n");
    const messages = await collectSse(Array.from(bytes, (byte) => new Uint8Array([byte])));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.data).toBe("逐字节");
  });

  it("流结束时补发未以空行结尾的事件", async () => {
    const messages = await collectSse([encoder.encode("data: tail")]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.data).toBe("tail");
  });

  it("忽略没有 data 的事件", async () => {
    const messages = await collectSse([encoder.encode("event: ping\n\n")]);
    expect(messages).toHaveLength(0);
  });

  it("超过大小限制时抛错", async () => {
    await expect(collectSse([encoder.encode(`data: ${"x".repeat(100)}\n\n`)], 20)).rejects.toBeInstanceOf(
      GatewayError,
    );
  });
});

// ---------------------------------------------------------------------------
// 协议流转换矩阵
// ---------------------------------------------------------------------------

const OPENAI_STREAM = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"reasoning"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Answer"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":"}}]}}]}\n\n',
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]}}]}\n\n',
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":2}}}\n\n',
  "data: [DONE]\n\n",
].join("");

const ANTHROPIC_STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"m","usage":{"input_tokens":8,"output_tokens":0,"cache_read_input_tokens":2}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reasoning"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Answer"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call_1","name":"lookup","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"x\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

const RESPONSES_STREAM = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"m"}}\n\n',
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[]}}\n\n',
  'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","output_index":0,"summary_index":0,"delta":"reasoning"}\n\n',
  'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning"}}\n\n',
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":1,"content_index":0,"delta":"Answer"}\n\n',
  'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"item":{"id":"msg_1","type":"message"}}\n\n',
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":2,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"lookup","arguments":""}}\n\n',
  'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":2,"delta":"{\\"q\\":\\"x\\"}"}\n\n',
  'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":2,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","model":"m","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,"input_tokens_details":{"cached_tokens":2},"output_tokens_details":{"reasoning_tokens":0}}}}\n\n',
].join("");

const GEMINI_STREAM = [
  'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"reasoning","thought":true,"thoughtSignature":"sig"}]},"index":0}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":0,"totalTokenCount":10,"cachedContentTokenCount":2},"modelVersion":"m","responseId":"g1"}\n\n',
  'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Answer"}]},"index":0}]}\n\n',
  'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"lookup","args":{"q":"x"}}}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15,"cachedContentTokenCount":2,"thoughtsTokenCount":0},"modelVersion":"m","responseId":"g1"}\n\n',
].join("");

const SOURCES: Array<{ id: string; adapter: ProtocolAdapter; text: string }> = [
  { id: "openai-chat", adapter: protocolRegistry.get("openai-chat"), text: OPENAI_STREAM },
  { id: "anthropic", adapter: protocolRegistry.get("anthropic"), text: ANTHROPIC_STREAM },
  { id: "openai-responses", adapter: protocolRegistry.get("openai-responses"), text: RESPONSES_STREAM },
  { id: "gemini", adapter: protocolRegistry.get("gemini"), text: GEMINI_STREAM },
];

async function parseStreamText(adapter: ProtocolAdapter, text: string): Promise<UnifiedStreamEvent[]> {
  const events: UnifiedStreamEvent[] = [];
  for await (const event of adapter.parseStream(
    readSseMessages(streamFromChunks([encoder.encode(text)])),
    { model: "m", requestId: "req_stream" },
  )) {
    events.push(event);
  }
  return events;
}

function asIterable(events: UnifiedStreamEvent[]): AsyncIterable<UnifiedStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

function summarize(events: UnifiedStreamEvent[]): {
  text: string;
  thinking: string;
  toolNames: string[];
  toolArgs: string;
  usageInput: number;
  usageOutput: number;
  stopReason: string | undefined;
} {
  let text = "";
  let thinking = "";
  let toolArgs = "";
  const toolNames: string[] = [];
  let usageInput = 0;
  let usageOutput = 0;
  let stopReason: string | undefined;
  for (const event of events) {
    if (event.type === "text_delta") text += event.text;
    else if (event.type === "thinking_delta") thinking += event.text;
    else if (event.type === "block_start" && event.block.kind === "tool_use") toolNames.push(event.block.name);
    else if (event.type === "tool_input_delta") toolArgs += event.partialJson;
    else if (event.type === "finish") {
      usageInput = event.usage.inputTokens;
      usageOutput = event.usage.outputTokens;
      stopReason = event.stopReason;
    }
  }
  return { text, thinking, toolNames, toolArgs, usageInput, usageOutput, stopReason };
}

describe("流式协议转换（源协议 → 四种下游协议）", () => {
  for (const source of SOURCES) {
    it(`解析 ${source.id} 上游流`, async () => {
      const summary = summarize(await parseStreamText(source.adapter, source.text));
      expect(summary.text).toBe("Answer");
      expect(summary.thinking).toBe("reasoning");
      expect(summary.toolNames).toContain("lookup");
      expect(summary.toolArgs).toContain('"q"');
      expect(summary.usageInput).toBe(10);
      expect(summary.usageOutput).toBe(5);
      expect(summary.stopReason).toBe("tool_use");
    });

    for (const target of protocolRegistry.list()) {
      it(`${source.id} 流渲染为 ${target.id} 后可被重新解析`, async () => {
        const irEvents = await parseStreamText(source.adapter, source.text);
        const rendered = target.renderStream(asIterable(irEvents), {
          requestId: "req_stream",
          model: "m",
          created: 1_700_000_000_000,
          policy: "warn",
          issues: [],
        });
        expect(rendered.status).toBe(200);
        const body = rendered.body as ReadableStream<Uint8Array>;
        const reparsed: UnifiedStreamEvent[] = [];
        for await (const event of target.parseStream(readSseMessages(body), {
          model: "m",
          requestId: "req_stream",
        })) {
          reparsed.push(event);
        }
        const summary = summarize(reparsed);
        expect(summary.text).toBe("Answer");
        expect(summary.thinking).toContain("reasoning");
        expect(summary.toolNames).toContain("lookup");
        expect(summary.toolArgs).toContain('"q"');
        expect(summary.usageInput).toBe(10);
        expect(summary.usageOutput).toBe(5);
        expect(summary.stopReason).toBe("tool_use");
      });
    }
  }
});

describe("流式取消", () => {
  it("下游取消读取会取消上游 ReadableStream", async () => {
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const adapter = protocolRegistry.get("openai-chat");
    const iterator = adapter
      .parseStream(readSseMessages(upstream), { model: "m", requestId: "req_cancel" })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    await iterator.return?.();
    expect(cancelled).toBe(true);
  });
});

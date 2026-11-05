// A tool-only turn has no text, so the request detail used to record
// "[Empty streaming response]" for it — an agent calling a function looked like
// an empty answer. The stream now keeps the tool calls and renders them as text
// when there is no prose, so the detail shows what actually happened.
import { describe, it, expect } from "vitest";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function sseStream(chunks) {
  const encoder = new TextEncoder();
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

async function drain(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

// Stream through the passthrough path (upstream and client speak the same
// format) and return what onStreamComplete reported.
async function collectComplete(chunks, { upstream = FORMATS.OPENAI } = {}) {
  let captured = null;
  const out = sseStream(chunks).pipeThrough(
    createPassthroughStreamWithLogger(
      "test-provider", // provider
      null, // reqLogger
      "test-model", // model
      null, // connectionId
      { messages: [] }, // body
      (contentObj) => { captured = contentObj; }, // onStreamComplete
    ),
  );
  await drain(out);
  return captured;
}

const OPENAI_TOOL_ONLY = [
  { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [
    { index: 0, id: "call_abc", type: "function", function: { name: "get_weather", arguments: "" } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [
    { index: 0, function: { arguments: '{"city":' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [
    { index: 0, function: { arguments: '"Beijing"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
];

const CLAUDE_TOOL_ONLY = [
  { type: "message_start", message: { id: "msg_1", model: "claude-opus-5", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"Beijing"}' } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 7 } },
  { type: "message_stop" },
];

describe("stream tool-call capture", () => {
  it("records OpenAI tool calls when the turn has no text", async () => {
    const captured = await collectComplete(OPENAI_TOOL_ONLY);
    expect(captured.content).toBe('get_weather({"city":"Beijing"})');
  });

  it("records Claude tool_use blocks reassembled from input_json_delta", async () => {
    // A Claude upstream serving an OpenAI client goes through translate mode.
    let captured = null;
    const out = sseStream(CLAUDE_TOOL_ONLY).pipeThrough(
      createSSETransformStreamWithLogger(
        FORMATS.OPENAI, // target
        FORMATS.CLAUDE, // source
        "test-provider",
        null, // reqLogger
        null, // toolNameMap
        "test-model",
        null, // connectionId
        { messages: [] },
        (contentObj) => { captured = contentObj; },
      ),
    );
    await drain(out);
    expect(captured.content).toBe('get_weather({"city":"Beijing"})');
  });

  it("keeps the prose when the turn has both text and a tool call", async () => {
    const withText = [
      { choices: [{ index: 0, delta: { content: "Let me check." } }] },
      ...OPENAI_TOOL_ONLY,
    ];
    const captured = await collectComplete(withText);
    expect(captured.content).toBe("Let me check.");
  });

  it("still reports empty content for a genuinely empty turn", async () => {
    const empty = [
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } },
    ];
    const captured = await collectComplete(empty);
    expect(captured.content).toBe("");
  });

  it("merges parallel tool calls in index order", async () => {
    const parallel = [
      { choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: "a", function: { name: "first", arguments: '{"x":1}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [
        { index: 1, id: "b", function: { name: "second", arguments: '{"y":2}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
    ];
    const captured = await collectComplete(parallel);
    expect(captured.content).toBe('first({"x":1})\nsecond({"y":2})');
  });
});
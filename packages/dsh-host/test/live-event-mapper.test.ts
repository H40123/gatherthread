import assert from "node:assert/strict";
import test from "node:test";
import { createLiveOutputPublisher, type LiveOutputUpdate } from "@gatherthread/adapters";
import { createDshLiveEventMapper, parseDshAssistantStreamFrame } from "../src/live-event-mapper.js";
import { mapDshSessionEvent } from "../src/event-mapper.js";
import type { DshAssistantStreamFrame, DshSessionEventRecord } from "../src/types.js";

function fixture() {
  const updates: LiveOutputUpdate[] = [];
  const publisher = createLiveOutputPublisher({ intervalMs: 0, schedule: false,
    publish(update) { updates.push(structuredClone(update)); } });
  const mapper = createDshLiveEventMapper(publisher);
  let index = 0;
  let revision = 0;
  const frame = (value: DshAssistantStreamFrame) => mapper.onEvent({ kind: "assistant-stream", sourceSessionId: "native-session", frame: value });
  return { updates, mapper, frame,
    start(id = "native-attempt") { index = 0; frame({ type: "start", attemptId: id, revision: ++revision, turn: 7, step: 1 }); },
    chunk(chunk: unknown, id = "native-attempt") {
      frame({ type: "chunk", attemptId: id, revision: ++revision, index: index++, time: 1700000000000, chunk });
    },
    end(failed = false) { frame({ type: "end", attemptId: "native-attempt", revision: ++revision, index,
      outcome: { kind: "committed", eventType: failed ? "assistant/attempt" : "assistant/message", seq: 3 } }); },
    durable(type: string, data: unknown, seq = 2) {
      mapper.onEvent({ kind: "session-event", sourceSessionId: "native-session", event: { type, data, seq, time: 1700000000000 } });
    },
  };
}

test("DSH native live blocks interleave answer, exposed reasoning, tools/results and whole todo snapshots", async () => {
  const f = fixture();
  f.start();
  f.chunk({ type: "block-start", index: 0, blockType: "text" });
  f.chunk({ type: "block-start", index: 1, blockType: "reasoning" });
  f.chunk({ type: "block-start", index: 2, blockType: "tool-call" });
  f.chunk({ type: "text-delta", index: 0, text: "Answer before " });
  f.chunk({ type: "reasoning-delta", index: 1, text: "Exposed native thinking " });
  f.chunk({ type: "tool-call-delta", index: 2, id: "native-call", name: "shell", argumentsDelta: '{"cmd":"echo safe","password":"' });
  f.chunk({ type: "text-delta", index: 0, text: "after." });
  f.chunk({ type: "reasoning-delta", index: 1, text: "continues." });
  f.chunk({ type: "tool-call-delta", index: 2, id: "native-call", argumentsDelta: 'split-secret"}' });
  f.chunk({ type: "block-end", index: 0, block: { type: "text", text: "Answer before after." } });
  f.chunk({ type: "block-end", index: 1, block: { type: "reasoning", text: "Exposed native thinking continues." } });
  f.chunk({ type: "block-end", index: 2, block: { type: "tool-call", id: "native-call", name: "shell", arguments: '{"cmd":"echo safe","password":"split-secret"}' } });
  f.chunk({ type: "usage", usage: { secret: "PRIVATE_USAGE" } });
  f.chunk({ type: "finish", reason: { kind: "tool-calls" }, replayState: "PRIVATE_REPLAY" });
  f.durable("assistant/message", { turn: 7, step: 1, message: { content: [
    { type: "text", text: "Answer before after." }, { type: "reasoning", text: "Exposed native thinking continues." },
  ] }, stream: "PRIVATE_DURABLE_STREAM", header: "PRIVATE_HEADER" });
  f.end();
  f.durable("tool/call", { turn: 7, step: 1, callId: "native-call", name: "shell", arguments: '{"cmd":"echo safe","api_key":"PRIVATE_ARGUMENT"}' });
  f.durable("tool/result", { turn: 7, step: 1, message: { content: [{ type: "tool-result", toolCallId: "native-call", content: [
    { type: "text", text: "safe result" }, { type: "reasoning", text: "PRIVATE_RESULT_REASONING" },
  ] }] }, meta: { diff: "PRIVATE_META" }, header: "PRIVATE_TOOL_HEADER" });
  f.durable("todo/write", { todos: [{ content: "Review results", status: "in_progress", internal: "PRIVATE_TODO" }] });
  await f.mapper.finish();
  const latest = new Map(f.updates.map((item) => [item.streamId, item]));
  assert.deepEqual([...latest.values()].map((item) => item.streamKind).sort(), ["answer", "plan", "reasoning", "tool"]);
  assert.equal([...latest.values()].find((item) => item.streamKind === "answer")?.content, "Answer before after.");
  assert.equal([...latest.values()].find((item) => item.streamKind === "reasoning")?.content, "Exposed native thinking continues.");
  const tool = [...latest.values()].find((item) => item.streamKind === "tool");
  assert.equal(tool?.title, "shell");
  assert.match(tool!.content, /Arguments:.*cmd.*echo safe[\s\S]*Result:\nsafe result/s);
  assert.equal(tool?.streamState, "completed");
  assert.deepEqual([...latest.values()].find((item) => item.streamKind === "plan")?.plan,
    [{ step: "Review results", status: "in_progress" }]);
  assert.doesNotMatch(JSON.stringify(f.updates), /native-attempt|native-call|native-session|split-secret|PRIVATE_/);
  assert.match(JSON.stringify(f.updates), /REDACTED/);
});

test("durable assistant settlement updates streamed content without duplicating its item", async () => {
  const f = fixture(); f.start();
  f.chunk({ type: "block-start", index: 0, blockType: "text" });
  f.chunk({ type: "text-delta", index: 0, text: "Partial " });
  f.durable("assistant/message", { turn: 7, step: 1, message: { content: [{ type: "text", text: "Partial with settled tail" }] } });
  f.end(); await f.mapper.finish();
  assert.equal(new Set(f.updates.map((item) => item.streamId)).size, 1);
  assert.equal(f.updates.at(-1)?.content, "Partial with settled tail");
});

test("DSH stream envelopes reject guessed aliases, malformed counters and duplicate chunks", async () => {
  assert.equal(parseDshAssistantStreamFrame({ type: "delta", attemptId: "x", revision: 1, text: "fake" }), undefined);
  assert.equal(parseDshAssistantStreamFrame({ type: "chunk", attemptId: "x", revision: -1, index: 0, time: 1, chunk: {} }), undefined);
  assert.equal(parseDshAssistantStreamFrame({ type: "end", attemptId: "x", revision: 1, index: 0, outcome: { kind: "committed", eventType: "request/header", seq: 1 } }), undefined);
  const f = fixture(); f.start();
  f.chunk({ type: "block-start", index: 0, blockType: "text" });
  f.chunk({ type: "text-delta", index: 0, text: "Once " });
  f.frame({ type: "chunk", attemptId: "native-attempt", revision: 1, index: 1, time: 1,
    chunk: { type: "text-delta", index: 0, text: "DUPLICATE " } });
  f.frame({ type: "chunk", attemptId: "OTHER_ATTEMPT", revision: 1, index: 2, time: 1,
    chunk: { type: "text-delta", index: 0, text: "UNRELATED " } });
  f.end(true); await f.mapper.finish();
  assert.equal(f.updates.at(-1)?.content, "Once ");
  assert.equal(f.updates.at(-1)?.streamState, "failed");
  assert.doesNotMatch(JSON.stringify(f.updates), /DUPLICATE|UNRELATED/);
});

test("headers, private instructions and unknown content have no live path and local uploads retain their allowlist", async () => {
  const f = fixture();
  for (const type of ["request/header", "request/context", "system/message", "user/message", "unknown/event"]) {
    f.durable(type, { text: "PRIVATE_INSTRUCTION", content: "PRIVATE_INPUT", messages: "PRIVATE_HISTORY" });
  }
  f.durable("tool/result", { message: { toolCallId: "missing", content: [{ type: "text", text: "UNRELATED_RESULT" }] } });
  const event: DshSessionEventRecord = { type: "assistant/message", seq: 8, time: 1700000000000,
    data: { turn: 7, step: 1, message: { content: [
      { type: "text", text: "public answer" }, { type: "reasoning", text: "exposed thought" },
      { type: "encrypted-reasoning", text: "PRIVATE_ENCRYPTED" }, { type: "system", text: "PRIVATE_SYSTEM" },
    ] } } };
  f.mapper.onEvent({ kind: "session-event", sourceSessionId: "native-session", event });
  await f.mapper.finish();
  assert.doesNotMatch(JSON.stringify(f.updates), /PRIVATE_|UNRELATED_RESULT/);
  assert.equal(f.updates.find((item) => item.streamKind === "reasoning")?.content, "exposed thought");
  assert.equal((mapDshSessionEvent(event) as { content: string }).content, "public answer");
});

test("todo snapshots replace and clear the same plan, discarding unknown fields", async () => {
  const f = fixture();
  f.durable("todo/write", { todos: [{ content: "Run checks", status: "pending" }], private: "PRIVATE_PLAN" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.durable("todo/write", { todos: [] });
  await f.mapper.finish();
  assert.equal(new Set(f.updates.map((item) => item.streamId)).size, 1);
  assert.deepEqual(f.updates.at(-1)?.plan, []);
  assert.equal(f.updates.at(-1)?.content, "");
});

test("fragmented Authorization and refresh_token arguments never enter immutable progress before structural redaction", async () => {
  const f = fixture(); f.start();
  f.chunk({ type: "block-start", index: 0, blockType: "tool-call" });
  f.chunk({ type: "tool-call-delta", index: 0, id: "secret-call", name: "request", argumentsDelta: '{"headers":{"Author' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.chunk({ type: "tool-call-delta", index: 0, id: "secret-call", argumentsDelta: 'ization":"SENSITIVE_PREFIX' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.chunk({ type: "tool-call-delta", index: 0, id: "secret-call", argumentsDelta: '_SECRET"},"refresh_' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.chunk({ type: "tool-call-delta", index: 0, id: "secret-call", argumentsDelta: 'token":"REFRESH_PREFIX' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.chunk({ type: "tool-call-delta", index: 0, id: "secret-call", argumentsDelta: '_SECRET","url":"https://example.invalid"}' });
  await f.mapper.finish();
  assert.doesNotMatch(JSON.stringify(f.updates), /SENSITIVE_PREFIX|REFRESH_PREFIX|PREFIX_SECRET/);
  assert.match(f.updates.at(-1)!.content, /example.invalid/);
  assert.match(f.updates.at(-1)!.content, /REDACTED/);
  assert.ok(f.updates.some((item) => item.content.includes("Preparing tool arguments.")));
});

test("native aborted finish and interrupted durable message keep their prefix failed after a committed end", async () => {
  const f = fixture(); f.start();
  f.chunk({ type: "block-start", index: 0, blockType: "text" });
  f.chunk({ type: "text-delta", index: 0, text: "Visible partial answer " });
  f.chunk({ type: "finish", reason: { kind: "aborted", failure: { message: "PRIVATE_PROVIDER_ERROR", headers: "PRIVATE_HEADERS" } } });
  f.durable("assistant/message", { turn: 7, step: 1, interrupted: true,
    message: { content: [{ type: "text", text: "Visible partial answer" }] } });
  f.end(); await f.mapper.finish();
  assert.equal(f.updates.at(-1)?.content, "Visible partial answer");
  assert.equal(f.updates.at(-1)?.streamState, "failed");
  assert.doesNotMatch(JSON.stringify(f.updates), /PRIVATE_/);
});

test("native Chinese answer and exposed thinking stream before settlement without a whitespace boundary", async () => {
  const f = fixture(); f.start();
  f.chunk({ type: "block-start", index: 0, blockType: "text" });
  f.chunk({ type: "text-delta", index: 0, text: "原生中文回答第一段，" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.updates.findLast((item) => item.streamKind === "answer")?.content, "原生中文回答第一段，");
  f.chunk({ type: "block-start", index: 1, blockType: "reasoning" });
  f.chunk({ type: "reasoning-delta", index: 1, text: "核对公式与参数。" });
  f.chunk({ type: "text-delta", index: 0, text: "随后补充下一段。" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.updates.findLast((item) => item.streamKind === "reasoning")?.content, "核对公式与参数。");
  assert.equal(f.updates.findLast((item) => item.streamKind === "answer")?.content, "原生中文回答第一段，随后补充下一段。");
  await f.mapper.finish();
});

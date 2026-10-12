import test from "node:test";
import assert from "node:assert/strict";
import { mergeProgressFragments, latestStreamedText } from "../src/domain.js";

const snapshot = (id, streamId, revision, content, options = {}) => ({
  id, type: "agent_progress", replyTo: options.request ?? "request-1",
  sequence: options.sequence ?? revision,
  createdAt: `2026-10-12T00:00:${String(revision).padStart(2, "0")}.000Z`,
  visibility: "session", actor: { id: "fixture-user", username: "Fixture" },
  payload: { phase: "stream", stream_id: streamId, stream_mode: "snapshot",
    stream_kind: options.kind ?? "answer", stream_revision: revision,
    stream_state: options.state ?? "running", content,
    ...(options.plan ? { plan: options.plan } : {}) },
});

test("interleaved cumulative snapshots replace their stream without moving its first anchor", () => {
  const first = snapshot("a1", "answer", 1, "Beginning");
  const latest = snapshot("a2", "answer", 2, "Beginning and continuation");
  const tool = snapshot("t1", "tool", 1, "Checking a synthetic fixture", { kind: "tool" });
  const entries = mergeProgressFragments([first, tool, latest]);
  assert.deepEqual(entries.map(entry => entry.content), [latest.payload.content, tool.payload.content]);
  assert.equal(entries[0].id, first.id);
  assert.equal(entries[0].createdAt, first.createdAt);
  assert.strictEqual(entries[0].event, latest, "copy and quote target the authoritative latest snapshot");
  assert.equal(entries[0].quoteable, true);
});

test("older revisions and replayed IDs never duplicate or replace newer text", () => {
  const latest = snapshot("a4", "answer", 4, "The complete growing answer");
  const old = snapshot("a2", "answer", 2, "The complete", { sequence: 5 });
  const entries = mergeProgressFragments([latest, old, latest]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].content, latest.payload.content);
  assert.strictEqual(entries[0].event, latest);
});

test("a stream ID reused in another request cannot join two requests", () => {
  const entries = mergeProgressFragments([
    snapshot("a1", "shared", 1, "Request one"),
    snapshot("b1", "shared", 1, "Request two", { request: "request-2" }),
    snapshot("a2", "shared", 2, "Request one complete"),
  ]);
  assert.deepEqual(entries.map(entry => entry.content), ["Request one complete", "Request two"]);
});

test("plan-only snapshots retain current step status and completion", () => {
  const plan = [{ step: "Read the fixture", status: "completed" }, { step: "Check the result", status: "in_progress" }];
  const latest = snapshot("p2", "plan", 2, "", { kind: "plan", plan, state: "completed" });
  const entries = mergeProgressFragments([
    snapshot("p1", "plan", 1, "", { kind: "plan", plan: [{ step: "Read the fixture", status: "pending" }] }), latest,
  ]);
  assert.deepEqual(entries[0].plan, plan);
  assert.equal(entries[0].streamKind, "plan");
  assert.equal(entries[0].streamState, "completed");
});

test("legacy fragments copy their full text but cannot quote a fabricated combined event", () => {
  const first = snapshot("l1", "legacy", 1, "Legacy ");
  const second = snapshot("l2", "legacy", 2, "answer");
  delete first.payload.stream_mode; delete second.payload.stream_mode;
  const entries = mergeProgressFragments([first, first, snapshot("t1", "tool", 1, "A tool", { kind: "tool" }), second]);
  assert.equal(entries[0].content, "Legacy answer");
  assert.equal(entries[0].quoteable, false);
  assert.strictEqual(entries[0].event, first, "the canonical source is never overwritten with synthetic text");
  assert.equal(entries[0].copyEvent.payload.content, "Legacy answer");
});

test("a single canonical legacy fragment is still quoteable", () => {
  const event = snapshot("l1", "legacy", 1, "One fragment");
  delete event.payload.stream_mode;
  const entries = mergeProgressFragments([event]);
  assert.strictEqual(entries[0].event, event);
  assert.equal(entries[0].quoteable, true);
});

test("the optional compact preview does not expose tool or thinking text as the answer", () => {
  const entries = [
    snapshot("a1", "answer", 1, "Answer so far"),
    snapshot("r1", "thinking", 1, "Exposed reasoning fixture", { kind: "reasoning" }),
    snapshot("t1", "tool", 1, "Public tool output", { kind: "tool" }),
  ];
  assert.equal(latestStreamedText(entries), "Answer so far");
});

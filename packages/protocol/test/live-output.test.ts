import assert from "node:assert/strict";
import test from "node:test";
import { LiveOutputPayloadSchema } from "../src/live-output.js";

const snapshot = {
  content: "Public answer", phase: "stream", stream_id: "d3d13506-3f26-48d8-9938-644fb9bb61d7",
  stream_mode: "snapshot", stream_kind: "answer", stream_revision: 1, stream_state: "running",
};

test("strict additive live snapshots validate all four kinds and reject native metadata", () => {
  for (const kind of ["answer", "reasoning", "tool", "plan"]) {
    assert.ok(LiveOutputPayloadSchema.safeParse({ ...snapshot, stream_kind: kind, ...(kind === "plan" ? { plan: [] } : {}) }).success);
  }
  for (const changes of [{ native_session_id: "private" }, { stream_id: "native-id" }, { stream_revision: 0 },
    { stream_revision: 1201 }, { stream_kind: "unknown" }, { stream_state: "unknown" }, { plan: [] }]) {
    assert.equal(LiveOutputPayloadSchema.safeParse({ ...snapshot, ...changes }).success, false);
  }
});

test("live contract uses UTF-8 byte bounds, bounded plan shape and empty-plan clearing", () => {
  assert.equal(LiveOutputPayloadSchema.safeParse({ ...snapshot, content: "文".repeat(8193) }).success, false);
  assert.equal(LiveOutputPayloadSchema.safeParse({ ...snapshot, title: "文".repeat(86) }).success, false);
  const plan = { ...snapshot, stream_kind: "plan", plan: [{ step: "Review", status: "pending" }] };
  assert.ok(LiveOutputPayloadSchema.safeParse(plan).success);
  assert.equal(LiveOutputPayloadSchema.safeParse({ ...plan, plan: [{ step: "Review", status: "pending", secret: "x" }] }).success, false);
  assert.equal(LiveOutputPayloadSchema.safeParse({ ...plan, plan: Array.from({ length: 65 }, () => ({ step: "Review", status: "pending" })) }).success, false);
  assert.equal(LiveOutputPayloadSchema.safeParse({ ...plan, plan: [{ step: "文".repeat(171), status: "pending" }] }).success, false);
  assert.ok(LiveOutputPayloadSchema.safeParse({ ...plan, plan: [] }).success);
});

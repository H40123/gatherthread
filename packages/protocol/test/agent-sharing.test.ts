import test from "node:test";
import assert from "node:assert/strict";
import { AgentShareLimitsSchema, SharedExecutionCapabilitySchema, SaveAgentShareInputSchema,
  ControlAgentShareInputSchema, SharedAgentRequestInputSchema, SharedAgentProfileSchema,
  ReportAgentShareSourceAvailabilityInputSchema } from "../src/index.js";

const profile = { harness: "codex", provider: "openai", model: "fixture-model", reasoning_effort: "high" };
test("native source availability binds an exact project/runtime before a share exists", () => {
  const value = { project_id: "project-fixture", source_runtime_id: "runtime-fixture", state: "offline", idempotency_key: "fixture-source-offline" };
  assert.ok(ReportAgentShareSourceAvailabilityInputSchema.safeParse(value).success);
  for (const invalid of [{ ...value, project_id: undefined }, { ...value, source_runtime_id: undefined },
    { ...value, state: "online" }, { ...value, enabled: true }, { ...value, owner_user_id: "other-user" }]) {
    assert.equal(ReportAgentShareSourceAvailabilityInputSchema.safeParse(invalid).success, false);
  }
});
test("sharing capability requires every native confinement and revocation fence", () => {
  const value = { version: 1, isolated: true, project_only: true, cancellation: true, liveness_watchdog: true };
  assert.ok(SharedExecutionCapabilitySchema.safeParse(value).success);
  for (const field of Object.keys(value)) assert.equal(SharedExecutionCapabilitySchema.safeParse({ ...value, [field]: false }).success, false);
  assert.equal(SharedExecutionCapabilitySchema.safeParse({ ...value, shell: true }).success, false);
});
test("share defaults are bounded and one exact supported native profile is granted", () => {
  const input = SaveAgentShareInputSchema.parse({ source_runtime_id: "runtime-owner", execution_profile: profile,
    allowed_user_ids: ["member-b", "member-c"], expected_revision: null, idempotency_key: "fixture-create" });
  assert.deepEqual(input.limits, { per_member_daily_calls: 20, per_member_daily_seconds: 3600,
    total_daily_calls: 100, total_daily_seconds: 18000, max_concurrent: 1, max_request_seconds: 720 });
  assert.equal(SharedAgentProfileSchema.safeParse({ ...profile, harness: "claude-code" }).success, false);
  assert.equal(SaveAgentShareInputSchema.safeParse({ ...input, allowed_user_ids: ["member-b", "member-b"] }).success, false);
  assert.equal(SaveAgentShareInputSchema.safeParse({ ...input, shared_agent: {} }).success, false);
  assert.equal(SaveAgentShareInputSchema.safeParse({ ...input, share_id: "share", expected_revision: null }).success, false);
});
test("limits cannot exceed daily budgets or twelve minutes; enabling is revision-bound", () => {
  const limits = AgentShareLimitsSchema.parse({});
  for (const change of [{ max_request_seconds: 721 }, { per_member_daily_calls: 101 }, { per_member_daily_seconds: 18001 },
    { max_concurrent: 0 }, { max_concurrent: 2 }, { max_request_seconds: 720, per_member_daily_seconds: 100 }]) {
    assert.equal(AgentShareLimitsSchema.safeParse({ ...limits, ...change }).success, false);
  }
  assert.ok(ControlAgentShareInputSchema.safeParse({ action: "disable", idempotency_key: "emergency-disable" }).success);
  assert.equal(ControlAgentShareInputSchema.safeParse({ action: "enable", idempotency_key: "enable-no-revision" }).success, false);
  assert.equal(SharedAgentRequestInputSchema.safeParse({ share_id: "share", share_revision: 1, content: "Do work",
    content_revision: 0, idempotency_key: "request-example", execution_profile: profile }).success, true);
});

test("autosave allows an empty stopped configuration while atomic start requires recipients", () => {
  const input = { source_runtime_id: "runtime-owner", allowed_user_ids: [], enabled: false,
    expected_revision: null, idempotency_key: "autosave-fixture" };
  assert.ok(SaveAgentShareInputSchema.safeParse(input).success);
  assert.equal(SaveAgentShareInputSchema.safeParse({ ...input, enabled: true }).success, false);
  assert.ok(SaveAgentShareInputSchema.safeParse({ ...input, enabled: true, allowed_user_ids: ["member-b"] }).success);
});

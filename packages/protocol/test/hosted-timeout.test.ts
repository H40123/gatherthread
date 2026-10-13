import assert from "node:assert/strict";
import test from "node:test";
import { HostedAgentRequestInputSchema, HostedHistorySummaryInputSchema, HostedAgentFailurePayloadSchema } from "../src/index.js";

test("cloud continuation and terminal classification are additive strict bounded contracts", () => {
  const input = { content: "Continue the original task", profile_id: "exact-profile", include_code: false,
    idempotency_key: "continue-stable-key", continue_from_event_id: "request-original" };
  assert.equal(HostedAgentRequestInputSchema.safeParse(input).success, true);
  assert.equal(HostedAgentRequestInputSchema.safeParse({ ...input, continue_from_event_id: "../request" }).success, false);
  assert.equal(HostedAgentRequestInputSchema.safeParse({ ...input, arbitrary_recovery_state: "private" }).success, false);
  assert.equal(HostedAgentRequestInputSchema.safeParse({ ...input, content: "测".repeat(6000) }).success, true);
  assert.equal(HostedAgentRequestInputSchema.safeParse({ ...input, content: "测".repeat(6001) }).success, false);
  const summary = { profile_id: "exact-profile", source_event_ids: ["public-source"],
    idempotency_key: "summary-continue-key", continue_from_event_id: "summary-original" };
  assert.equal(HostedHistorySummaryInputSchema.safeParse(summary).success, true);
  assert.equal(HostedHistorySummaryInputSchema.safeParse({ ...summary, recovered_prompt: "private" }).success, false);
  const terminal = { status: "failed", outcome: "timed_out", content: "Cloud Agent timed out.", error: { code: "provider_timeout", provider_attempts: 1 } };
  assert.equal(HostedAgentFailurePayloadSchema.safeParse(terminal).success, true);
  for (const value of [{ ...terminal, outcome: "unknown" }, { ...terminal, raw_error: "private" },
    { ...terminal, error: { code: "provider_timeout", provider_attempts: 65 } },
    { ...terminal, error: { code: "provider_timeout", private_reasoning: "private" } }]) {
    assert.equal(HostedAgentFailurePayloadSchema.safeParse(value).success, false);
  }
});
